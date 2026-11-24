import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createRegistrationCommandGuards,
  REGISTRATION_CLIENT_ATTEMPTS,
  type RegistrationOperation,
} from '../registration-command-limits';
import type { ClientCommandRedis } from '../client-command-limits';
import { resetAllRateLimits, RateLimitError } from '../../../utils/rate-limiter';
import { PasswordComparesSaturatedError } from '../password-compare-gate';

const now = () => 1_800_030_000;
const client = (clientAddress: string | undefined = '8.8.8.8') => ({ clientAddress });
function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => resetAllRateLimits());
describe('registration command admission isolation and bounds', () => {
  it.each(['register', 'verify-email', 'resend-verification'] as const)(
    'enforces its own %s client window without coupling operations',
    async (operation) => {
      const guards = createRegistrationCommandGuards({ redis: () => null, now });
      for (let attempt = 0; attempt < REGISTRATION_CLIENT_ATTEMPTS[operation]; attempt++)
        await guards.limits[operation].admit(client());
      await expect(guards.limits[operation].admit(client())).rejects.toBeInstanceOf(RateLimitError);
      await expect(guards.limits[operation].admit(client('1.1.1.1'))).resolves.toBeDefined();
      for (const other of ['register', 'verify-email', 'resend-verification'] as RegistrationOperation[])
        if (other !== operation) await expect(guards.limits[other].admit(client())).resolves.toBeDefined();
    },
  );
  it('keeps an unrelated vouched client available after more than180 other clients', async () => {
    const guards = createRegistrationCommandGuards({ redis: () => null, now });
    for (let index = 1; index <= 181; index++)
      await guards.limits['verify-email'].admit(client(`8.8.${Math.floor(index / 250)}.${(index % 250) + 1}`));
    await expect(guards.limits['verify-email'].admit(client('1.1.1.1'))).resolves.toBeDefined();
  });
  it('charges only unvouched ingress to its process fallback budget', async () => {
    const guards = createRegistrationCommandGuards({ redis: () => null, now });
    for (let index = 0; index < 180; index++) await guards.limits['verify-email'].admit({ clientAddress: undefined });
    await expect(guards.limits['verify-email'].admit({ clientAddress: undefined })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    await expect(guards.limits['verify-email'].admit(client())).resolves.toBeDefined();
    await expect(guards.limits['resend-verification'].admit({ clientAddress: undefined })).resolves.toBeDefined();
  });
  it('does not evict tracked clients when the bounded local table fills', async () => {
    const guards = createRegistrationCommandGuards({ redis: () => null, now, maxLocalClients: 1 });
    await guards.limits['verify-email'].admit(client('1.1.1.1'));
    for (let index = 0; index < 180; index++)
      await guards.limits['verify-email'].admit(client(`8.8.${Math.floor(index / 250)}.${(index % 250) + 1}`));
    await expect(guards.limits['verify-email'].admit(client('9.9.9.9'))).rejects.toBeInstanceOf(RateLimitError);
    await expect(guards.limits['verify-email'].admit(client('1.1.1.1'))).resolves.toBeDefined();
  });
  it('shares an atomic Redis client window across replicas with operation-specific keys and TTLs', async () => {
    const fields = new Map<string, Set<string>>();
    const redis: ClientCommandRedis = {
      eval: async (_script, _keys, ...arguments_) => {
        const [key, limit, attemptId, ttl] = arguments_;
        expect(Number(ttl)).toBeGreaterThan(0);
        expect(Number(ttl)).toBeLessThanOrEqual(60_000);
        const stored = fields.get(String(key)) ?? new Set<string>();
        if (stored.size >= Number(limit)) return 1;
        stored.add(String(attemptId));
        fields.set(String(key), stored);
        return 0;
      },
      hdel: async (key, field) => (fields.get(key)?.delete(field) ? 1 : 0),
    };
    const first = createRegistrationCommandGuards({ redis: () => redis, now });
    const second = createRegistrationCommandGuards({ redis: () => redis, now });
    for (let index = 0; index < 20; index++) await (index % 2 ? first : second).limits['verify-email'].admit(client());
    await expect(first.limits['verify-email'].admit(client())).rejects.toBeInstanceOf(RateLimitError);
    await expect(second.limits.register.admit(client())).resolves.toBeDefined();
    expect([...fields.keys()]).toHaveLength(2);
    expect([...fields.keys()].every((key) => key.startsWith('ratelimit:registration:'))).toBe(true);
  });
  it.each(['resolve', 'reject'])('keeps Redis capacity after timeout until actual late %s', async (outcome) => {
    let settle: () => void = () => {};
    const stalled = new Promise<number>((resolve, reject) => {
      settle = () => (outcome === 'resolve' ? resolve(0) : reject(new Error('owned late Redis failure')));
    });
    const evaluate = vi
      .fn()
      .mockImplementationOnce(() => stalled)
      .mockResolvedValue(0);
    const guards = createRegistrationCommandGuards({
      redis: () => ({ eval: evaluate, hdel: async () => 0 }),
      now,
      maxPendingRedisCommands: 1,
    });
    await guards.limits['verify-email'].admit(client()); //100ms caller deadline; underlying command still held
    for (let index = 1; index <= 25; index++) await guards.limits['verify-email'].admit(client(`8.8.4.${index}`));
    expect(evaluate).toHaveBeenCalledTimes(1);
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await guards.limits['verify-email'].admit(client('1.1.1.1'));
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it('retains work capacity through actual settlement after an active caller aborts', async () => {
    const guards = createRegistrationCommandGuards({ redis: () => null, concurrency: 1, maxWaiting: 0 });
    const held = barrier();
    const release = barrier();
    const abort = new AbortController();
    const gate = guards.work('verify-email', 'client');
    const work = gate.run(async () => {
      held.resolve();
      await release.promise;
      return 'settled';
    }, abort.signal);
    await held.promise;
    abort.abort();
    expect(gate.isFull()).toBe(true);
    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(PasswordComparesSaturatedError);
    expect(guards.work('register', 'client').isFull()).toBe(false);
    expect(guards.work('verify-email', 'unattributed').isFull()).toBe(false);
    release.resolve();
    expect(await work).toBe('settled');
    expect(gate.isFull()).toBe(false);
  });
  it('routes table-full fallback into unattributed work slots', async () => {
    const guards = createRegistrationCommandGuards({ redis: () => null, maxLocalClients: 1 });
    const tracked = await guards.limits['verify-email'].admit(client('1.1.1.1'));
    const fallback = await guards.limits['verify-email'].admit(client('8.8.8.8'));
    expect(tracked.source).toBe('client');
    expect(fallback.source).toBe('unattributed');
    expect(guards.work('verify-email', fallback.source)).not.toBe(guards.work('verify-email', tracked.source));
  });
  it('cannot rewind newer local quotas when old Redis work times out', async () => {
    let instant = 59_990;
    let release = () => {};
    const stalled = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    const guards = createRegistrationCommandGuards({
      redis: () => ({ eval: async () => stalled, hdel: async () => 0 }),
      now: () => instant,
      maxPendingRedisCommands: 1,
    });
    const old = guards.limits['verify-email'].admit(client()).then(
      () => null,
      (error: unknown) => error,
    );
    instant = 60_010;
    for (let index = 0; index < 20; index++) await guards.limits['verify-email'].admit(client('1.1.1.1'));
    await expect(guards.limits['verify-email'].admit(client('1.1.1.1'))).rejects.toBeInstanceOf(RateLimitError);
    expect(await old).toBeNull();
    await expect(guards.limits['verify-email'].admit(client('1.1.1.1'))).rejects.toBeInstanceOf(RateLimitError);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
