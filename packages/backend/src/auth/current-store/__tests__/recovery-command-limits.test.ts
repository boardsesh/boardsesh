import { describe, expect, it, vi } from 'vite-plus/test';
import { createRecoveryCommandGuards } from '../recovery-command-limits';

describe('bounded recovery family admission', () => {
  it.each(['resolve', 'reject'] as const)(
    'keeps underlying timed-out Redis work in custody until %s',
    async (settlement) => {
      const pending: { resolve(result: unknown): void; reject(error: Error): void }[] = [];
      const redis = {
        eval: vi.fn(
          () =>
            new Promise<unknown>((resolve, reject) => {
              pending.push({ resolve, reject });
            }),
        ),
        hdel: vi.fn(async () => 0),
      };
      const guards = createRecoveryCommandGuards({ redis: () => redis });
      const admit = (suffix: number) => guards.limits['reset-password'].admit({ clientAddress: `192.0.2.${suffix}` });
      await Promise.all([1, 2, 3, 4, 5, 6].map(admit));
      expect(redis.eval).toHaveBeenCalledTimes(4);
      await admit(7);
      expect(redis.eval).toHaveBeenCalledTimes(4);
      const first = pending.shift();
      if (!first) throw new Error('Held underlying Redis operation missing');
      if (settlement === 'resolve') first.resolve(null);
      else first.reject(new Error('Owned late Redis failure'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await admit(8);
      expect(redis.eval).toHaveBeenCalledTimes(5);
      for (const command of pending) command.resolve(null);
      expect(redis.hdel).not.toHaveBeenCalled(); // Recovery counts commands, not rejected-password guesses.
    },
  );
  it('keeps independent operation and vouched/unattributed work lanes', async () => {
    const guards = createRecoveryCommandGuards({ redis: () => null, concurrency: 1, maxWaiting: 0 });
    const unauthenticated = await guards.limits['reset-password'].admit({ clientAddress: undefined });
    const vouched = await guards.limits['reset-password'].admit({ clientAddress: '192.0.2.1' });
    let finish: (() => void) | undefined;
    const held = guards.work('reset-password', unauthenticated.source).run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(guards.work('reset-password', unauthenticated.source).isFull()).toBe(true);
    expect(guards.work('reset-password', vouched.source).isFull()).toBe(false);
    expect(guards.work('forgot-password', unauthenticated.source).isFull()).toBe(false);
    finish?.();
    await held;
  });
});
