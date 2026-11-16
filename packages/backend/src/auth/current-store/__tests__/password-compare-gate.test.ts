import { describe, expect, it } from 'vite-plus/test';
import { reportedClientLimitKey } from '../../../utils/client-ip';
import { RateLimitError } from '../../../utils/rate-limiter';
import {
  createPasswordCompareGate,
  PasswordCompareAbortedError,
  PasswordComparesSaturatedError,
} from '../password-compare-gate';
import {
  createPasswordLoginLimiter,
  PASSWORD_LOGIN_CLIENT_LIMIT,
  passwordLoginMetrics,
  UNATTRIBUTED_PASSWORD_LOGIN_BUDGET,
} from '../password-login-limits';

function held() {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, done };
}

describe('password compare gate', () => {
  it('runs one sign-in at a time, first come first served', async () => {
    const gate = createPasswordCompareGate({ maxWaiting: 4 });
    const order: string[] = [];
    const blocker = held();
    const running = gate.run(async () => {
      order.push('running');
      await blocker.done;
    });
    const waiting = ['second', 'third'].map((name) =>
      gate.run(async () => {
        order.push(name);
      }),
    );
    expect(gate.waiting()).toBe(2);
    blocker.release();
    await Promise.all([running, ...waiting]);
    expect(order).toEqual(['running', 'second', 'third']);
  });

  it('refuses a sign-in when the queue is full, and frees the slot when a compare throws', async () => {
    const gate = createPasswordCompareGate({ maxWaiting: 1 });
    const blocker = held();
    const running = gate.run(() => blocker.done.then(() => Promise.reject(new Error('compare failed'))));
    const queued = gate.run(async () => 'queued ran');
    expect(gate.isFull()).toBe(true);
    await expect(gate.run(async () => 'never')).rejects.toBeInstanceOf(PasswordComparesSaturatedError);
    blocker.release();
    await expect(running).rejects.toThrow('compare failed');
    await expect(queued).resolves.toBe('queued ran');
    expect(gate.isFull()).toBe(false);
    await expect(gate.run(async () => 'free again')).resolves.toBe('free again');
  });

  it('gives up on a wait at its deadline without running the compare', async () => {
    const gate = createPasswordCompareGate({ waitMs: 50 });
    const blocker = held();
    const running = gate.run(() => blocker.done);
    let ran = false;
    const started = performance.now();
    await expect(
      gate.run(async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(PasswordComparesSaturatedError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
    expect(gate.waiting()).toBe(0);
    blocker.release();
    await running;
    expect(ran).toBe(false);
  });

  it('drops a waiting sign-in whose caller went away, and hands the slot to the next one', async () => {
    const gate = createPasswordCompareGate();
    const blocker = held();
    const running = gate.run(() => blocker.done);
    const callerGone = new AbortController();
    const ran: string[] = [];
    const abandoned = gate.run(async () => {
      ran.push('abandoned');
    }, callerGone.signal);
    const next = gate.run(async () => {
      ran.push('next');
    });
    callerGone.abort();
    await expect(abandoned).rejects.toBeInstanceOf(PasswordCompareAbortedError);
    expect(gate.waiting()).toBe(1);
    blocker.release();
    await Promise.all([running, next]);
    expect(ran).toEqual(['next']);
    await expect(gate.run(async () => 'x', AbortSignal.abort())).rejects.toBeInstanceOf(PasswordCompareAbortedError);
  });
});

describe('reported client address', () => {
  it('keys a public IPv4 address as itself and a public IPv6 address by its /64', () => {
    expect(reportedClientLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(reportedClientLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(reportedClientLimitKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(reportedClientLimitKey('2001:DB8:1:2::9')).toBe('2001:db8:1:2::/64');
  });

  it('never keys on a missing, private, loopback or carrier-NAT address', () => {
    for (const address of [undefined, '', '10.0.0.4', '127.0.0.1', '::1', 'fd12:3456::1', '100.64.0.1', 'fe80::1']) {
      expect(reportedClientLimitKey(address)).toBeNull();
    }
  });
});

describe('per-client limit without Redis', () => {
  const midMinute = () => Math.floor(Date.now() / 60_000) * 60_000 + 30_000;

  it('keeps counting the clients it holds when the table is full, and sends new ones to the process budget', async () => {
    const now = midMinute();
    const limiter = createPasswordLoginLimiter({ redis: () => null, now: () => now, maxLocalClients: 2 });
    for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
      await limiter.admit({ clientAddress: '203.0.113.1' });
    }
    await limiter.admit({ clientAddress: '203.0.113.2' });
    const before = passwordLoginMetrics().unattributed.local_table_full;
    // A third client finds no room and is counted against the process budget instead.
    for (let attempt = 0; attempt < UNATTRIBUTED_PASSWORD_LOGIN_BUDGET.attempts; attempt += 1) {
      await limiter.admit({ clientAddress: '203.0.113.3' });
    }
    expect(passwordLoginMetrics().unattributed.local_table_full).toBe(
      before + UNATTRIBUTED_PASSWORD_LOGIN_BUDGET.attempts,
    );
    await expect(limiter.admit({ clientAddress: `203.0.113.4` })).rejects.toBeInstanceOf(RateLimitError);
    // The spray evicted nobody: the first client is still out of attempts.
    await expect(limiter.admit({ clientAddress: '203.0.113.1' })).rejects.toMatchObject({ retryAfterSeconds: 30 });
  });

  it('empties the table when the minute turns', async () => {
    let now = midMinute();
    const limiter = createPasswordLoginLimiter({ redis: () => null, now: () => now, maxLocalClients: 1 });
    for (let attempt = 0; attempt < PASSWORD_LOGIN_CLIENT_LIMIT.attempts; attempt += 1) {
      await limiter.admit({ clientAddress: '203.0.113.9' });
    }
    await expect(limiter.admit({ clientAddress: '203.0.113.9' })).rejects.toBeInstanceOf(RateLimitError);
    now += 60_000;
    await expect(limiter.admit({ clientAddress: '203.0.113.9' })).resolves.toBeDefined();
  });
});
