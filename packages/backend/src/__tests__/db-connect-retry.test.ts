import { describe, expect, it, afterEach } from 'vite-plus/test';
import net from 'node:net';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  backoffDelayMs,
  connectErrorCode,
  isRetryableConnectError,
  setDbConnectObserver,
  withConnectRetry,
  withDbConnectRetry,
} from '@boardsesh/db/client';
import type { DbConnectRetryEvent, PoolInstance } from '@boardsesh/db/client';

function connectError(code: string): Error & { code: string } {
  return Object.assign(new Error(`write ${code} db.internal:5432`), { code });
}

const noSleep = () => Promise.resolve();

afterEach(() => {
  setDbConnectObserver(null);
});

describe('connectErrorCode', () => {
  it('accepts only the pre-dispatch connect codes', () => {
    for (const code of ['CONNECT_TIMEOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EAI_NODATA', 'ENOTFOUND']) {
      expect(connectErrorCode(connectError(code))).toBe(code);
      expect(isRetryableConnectError(connectError(code))).toBe(true);
    }
  });

  it('rejects codes that are ambiguous about whether the statement was dispatched', () => {
    for (const code of ['CONNECTION_CLOSED', 'ETIMEDOUT', 'ECONNRESET', '57014', '23505']) {
      expect(connectErrorCode(connectError(code))).toBeNull();
      expect(isRetryableConnectError(connectError(code))).toBe(false);
    }
    expect(isRetryableConnectError(new Error('boom'))).toBe(false);
    expect(isRetryableConnectError(null)).toBe(false);
    expect(isRetryableConnectError('ECONNREFUSED')).toBe(false);
  });
});

describe('withDbConnectRetry', () => {
  it('runs once when the statement succeeds', async () => {
    let calls = 0;
    const result = await withDbConnectRetry(
      () => {
        calls += 1;
        return Promise.resolve('rows');
      },
      { sleep: noSleep },
    );

    expect(result).toBe('rows');
    expect(calls).toBe(1);
  });

  it('retries a connect failure and reports every retry to the observer', async () => {
    const events: DbConnectRetryEvent[] = [];
    setDbConnectObserver((event) => events.push(event));

    let calls = 0;
    const result = await withDbConnectRetry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(connectError('EAI_AGAIN')) : Promise.resolve('rows');
      },
      { attempts: 3, sleep: noSleep },
    );

    expect(result).toBe('rows');
    expect(calls).toBe(3);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
    expect(events.every((event) => event.code === 'EAI_AGAIN' && event.maxAttempts === 3)).toBe(true);
  });

  it('rethrows the last error unchanged once attempts are exhausted', async () => {
    const failure = connectError('ECONNREFUSED');
    let calls = 0;

    await expect(
      withDbConnectRetry(
        () => {
          calls += 1;
          return Promise.reject(failure);
        },
        { attempts: 3, sleep: noSleep },
      ),
    ).rejects.toBe(failure);

    expect(calls).toBe(3);
  });

  it('never retries an error that could have reached the server', async () => {
    let calls = 0;
    const failure = connectError('CONNECTION_CLOSED');

    await expect(
      withDbConnectRetry(
        () => {
          calls += 1;
          return Promise.reject(failure);
        },
        { attempts: 5, sleep: noSleep },
      ),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
  });

  it('gives up immediately when the first attempt already burned the wall-clock budget', async () => {
    // A CONNECT_TIMEOUT costs the full connect_timeout (30s). Retrying it would
    // double the user's wait and hold a second pool slot, so the budget gate
    // must stop the loop even though the code is on the allowlist.
    let calls = 0;
    let clock = 0;
    const failure = connectError('CONNECT_TIMEOUT');

    await expect(
      withDbConnectRetry(
        () => {
          calls += 1;
          clock += 30_000;
          return Promise.reject(failure);
        },
        { attempts: 3, budgetMs: 10_000, sleep: noSleep, now: () => clock },
      ),
    ).rejects.toBe(failure);

    expect(calls).toBe(1);
  });

  it('stops retrying a fast code once postgres.js has slowed the attempts down', async () => {
    // ECONNREFUSED is only cheap for the first few failures of an outage:
    // postgres.js paces its own connect attempts with a pool-wide backoff that
    // ramps to a 20s cap (index.js:511, connection.js:455), so deep into an
    // outage one attempt costs seconds. The budget is the only thing bounding
    // how much of that a single user request absorbs, so pin it for the
    // allowlisted code the docs describe as "fast", not just CONNECT_TIMEOUT.
    let calls = 0;
    let clock = 0;
    const failure = connectError('ECONNREFUSED');

    await expect(
      withDbConnectRetry(
        () => {
          calls += 1;
          clock += 6_000;
          return Promise.reject(failure);
        },
        { attempts: 3, budgetMs: 10_000, sleep: noSleep, now: () => clock },
      ),
    ).rejects.toBe(failure);

    // One retry (6s elapsed, inside the budget), then the second attempt puts
    // elapsed at 12s and the loop stops instead of running to `attempts`.
    expect(calls).toBe(2);
  });

  it('keeps a misbehaving observer from breaking the retry', async () => {
    setDbConnectObserver(() => {
      throw new Error('observer blew up');
    });

    let calls = 0;
    const result = await withDbConnectRetry(
      () => {
        calls += 1;
        return calls < 2 ? Promise.reject(connectError('ENOTFOUND')) : Promise.resolve('rows');
      },
      { attempts: 2, sleep: noSleep },
    );

    expect(result).toBe('rows');
  });
});

describe('backoffDelayMs', () => {
  it('grows, stays inside the +/-50% jitter envelope, and never exceeds the cap', () => {
    for (const random of [0, 0.5, 0.999]) {
      expect(backoffDelayMs(1, 150, 600, () => random)).toBeGreaterThanOrEqual(75);
      expect(backoffDelayMs(1, 150, 600, () => random)).toBeLessThanOrEqual(225);
      expect(backoffDelayMs(2, 150, 600, () => random)).toBeLessThanOrEqual(450);
      // attempt 5 would be 2400ms unjittered; the cap holds it at 600 * 1.5.
      expect(backoffDelayMs(5, 150, 600, () => random)).toBeLessThanOrEqual(900);
    }
  });
});

type FakeQuery = PromiseLike<unknown> & { values: () => FakeQuery };

function fakeClient(run: (mode: 'rows' | 'values') => Promise<unknown>) {
  let unsafeCalls = 0;
  const client = {
    unsafe(query: string, params?: unknown[]) {
      unsafeCalls += 1;
      void query;
      void params;
      let mode: 'rows' | 'values' = 'rows';
      const fake: FakeQuery = {
        values() {
          mode = 'values';
          return fake;
        },
        then(onFulfilled, onRejected) {
          return run(mode).then(onFulfilled, onRejected);
        },
      };
      return fake;
    },
    get unsafeCalls() {
      return unsafeCalls;
    },
    options: { parsers: {} as Record<string, unknown> },
    begin: (fn: unknown) => fn,
  };
  return client;
}

describe('withConnectRetry (pool wrapper)', () => {
  it('retries a connect failure for a single statement issued through unsafe()', async () => {
    let attempts = 0;
    const client = fakeClient(() => {
      attempts += 1;
      return attempts < 3 ? Promise.reject(connectError('ECONNREFUSED')) : Promise.resolve([{ ok: 1 }]);
    });

    const wrapped = withConnectRetry(client as unknown as PoolInstance, { attempts: 3, sleep: noSleep });
    await expect(wrapped.unsafe('select 1')).resolves.toEqual([{ ok: 1 }]);
    expect(attempts).toBe(3);
    // Every attempt builds a fresh postgres.js query — a rejected one can never
    // be re-awaited.
    expect(client.unsafeCalls).toBe(3);
  });

  it('preserves .values() across retries', async () => {
    const modes: string[] = [];
    let attempts = 0;
    const client = fakeClient((mode) => {
      modes.push(mode);
      attempts += 1;
      return attempts < 2 ? Promise.reject(connectError('EAI_AGAIN')) : Promise.resolve([[1]]);
    });

    const wrapped = withConnectRetry(client as unknown as PoolInstance, { attempts: 2, sleep: noSleep });
    await expect(wrapped.unsafe('select 1').values()).resolves.toEqual([[1]]);
    expect(modes).toEqual(['values', 'values']);
  });

  it('does not retry statements that may already have reached the server', async () => {
    let attempts = 0;
    const failure = connectError('CONNECTION_CLOSED');
    const client = fakeClient(() => {
      attempts += 1;
      return Promise.reject(failure);
    });

    const wrapped = withConnectRetry(client as unknown as PoolInstance, { attempts: 3, sleep: noSleep });
    await expect(wrapped.unsafe('insert into ticks values (1)')).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it('passes non-statement members straight through so drizzle can install its parsers', () => {
    const client = fakeClient(() => Promise.resolve([]));
    const wrapped = withConnectRetry(client as unknown as PoolInstance, { sleep: noSleep });

    // drizzle mutates client.options.parsers when it constructs — that has to
    // land on the real pool, not on a copy.
    (wrapped.options.parsers as Record<string, unknown>)['1184'] = 'transparent';
    expect(client.options.parsers['1184']).toBe('transparent');
    expect(typeof wrapped.begin).toBe('function');
  });
});

async function reserveDeadPort(): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function deadPool(port: number, max: number) {
  return postgres(`postgresql://boardsesh:boardsesh@127.0.0.1:${port}/boardsesh`, {
    max,
    connect_timeout: 2,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
    // postgres.js paces its OWN connect attempts with a pool-wide backoff
    // (`options.shared.retries` at connection.js:455, `backoff()` at
    // index.js:511), which ramps to a 20s cap after ~8 failed connects and only
    // resets on a success. Measured on a dead port with stock postgres.js and
    // no wrapper at all, nine sequential connects take 7, 2, 17, 43, 131, 637,
    // 1305, 2540, 14204 ms. Pinning it to 0 keeps these tests measuring OUR
    // retry loop instead of that ramp. The production consequence is real and
    // documented in docs/db-connectivity.md — it is what the wall-clock budget
    // exists to bound, and it is why an ECONNREFUSED is only "fast" for the
    // first few failures of an outage.
    backoff: () => 0,
  });
}

// Fast, deterministic backoff: these tests are about the retry loop driving a
// real postgres.js pool, not about the jitter envelope (covered above).
const FAST_BACKOFF = { baseDelayMs: 5, maxDelayMs: 10 } as const;

describe('pool recovery after repeated connect failures', () => {
  // The regression this whole PR is fenced against: a retry that leaves
  // postgres.js's connection bookkeeping wedged. The refuted `options.socket`
  // design stranded connections in the `connecting` queue, so after `max`
  // failures every query hung forever. This drives the retry loop — attempts
  // greater than 1, so the wrapper really re-enters the pool — against a real
  // pool on a dead port, then proves the pool still opens a socket afterwards.
  it('retries through a real pool, keeps rejecting promptly, and still reconnects', async () => {
    const port = await reserveDeadPort();
    const pool = deadPool(port, 2);
    const events: DbConnectRetryEvent[] = [];
    setDbConnectObserver((event) => events.push(event));

    const retrying = withConnectRetry(pool, { attempts: 3, ...FAST_BACKOFF });
    const accepted: net.Socket[] = [];
    let connectionsSeen = 0;
    // Accepts the TCP connection and then says nothing, so postgres.js reaches
    // its own connect timeout and rejects. A listener that hung up instead
    // would leave the query attached to the connection, and postgres.js
    // answers that with an unbounded reconnect loop (connection.js:449).
    const revived = net.createServer((socket) => {
      connectionsSeen += 1;
      accepted.push(socket);
      socket.on('error', () => {});
    });

    try {
      // max + 1 statements against a dead port: every one exhausts its attempts,
      // rejects, and none hangs.
      for (let index = 0; index < 3; index += 1) {
        const startedAt = Date.now();
        await expect(retrying.unsafe('select 1')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      }

      // Non-vacuous: 3 statements x (3 attempts - 1) retries, all against the
      // real pool. A wrapper that silently stopped retrying would report none.
      expect(events).toHaveLength(6);
      expect(events.every((event) => event.code === 'ECONNREFUSED')).toBe(true);
      expect(events.map((event) => event.attempt)).toEqual([1, 2, 1, 2, 1, 2]);

      await new Promise<void>((resolve, reject) => {
        revived.once('error', reject);
        revived.listen(port, '127.0.0.1', () => resolve());
      });

      // 9 failed connects later the pool is not wedged: it opens a socket
      // again instead of queueing the query forever. attempts:1 here so the
      // assertion costs one connect_timeout, not three.
      const once = withConnectRetry(pool, { attempts: 1 });
      await expect(once.unsafe('select 1')).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
      expect(connectionsSeen).toBeGreaterThan(0);
    } finally {
      await pool.end({ timeout: 1 });
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => revived.close(() => resolve()));
    }
  }, 20_000);
});

describe('drizzle traffic through the wrapped pool', () => {
  // The PR's coverage claim is "drizzle issues every statement through
  // unsafe(), so all drizzle traffic is retried". Read off drizzle's source it
  // is an assertion about a vendored file; here it is exercised end to end, so
  // a drizzle upgrade that adds another statement path fails this test.
  it('retries a drizzle statement and leaves transaction bodies alone', async () => {
    const port = await reserveDeadPort();
    const pool = deadPool(port, 1);
    const events: DbConnectRetryEvent[] = [];
    setDbConnectObserver((event) => events.push(event));

    const db = drizzle(withConnectRetry(pool, { attempts: 3, ...FAST_BACKOFF }));

    try {
      await expect(db.execute(sql`select 1`)).rejects.toThrow();
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.code === 'ECONNREFUSED')).toBe(true);

      // A transaction must fail as a whole rather than replay half its
      // statements: postgres.js runs `begin` and the whole body against the
      // scoped client it builds internally (index.js:242, 252), which never
      // passes through the wrapper. Zero retries proves it.
      events.length = 0;
      await expect(db.transaction(async (tx) => tx.execute(sql`select 1`))).rejects.toThrow();
      expect(events).toEqual([]);
    } finally {
      await pool.end({ timeout: 1 });
    }
  }, 20_000);
});
