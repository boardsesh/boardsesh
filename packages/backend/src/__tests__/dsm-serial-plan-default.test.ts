/**
 * Round 5 of the Postgres DSM saga (#5352; #2378, #3856, #4105, #4235, #4528
 * before it).
 *
 * `could not resize shared memory segment ... No space left on device`
 * (SQLSTATE 53100) is a parallel-query failure: Postgres could not get the
 * dynamic shared memory a parallel worker needs out of the container's
 * /dev/shm. Rounds 1-4 each wrapped one more call site in `SET LOCAL
 * max_parallel_workers_per_gather = 0`, and each of those genuinely worked —
 * every guarded resolver went quiet in Sentry the day its guard shipped. What
 * failed was the strategy: ~65 backend statements have the shape that can be
 * promoted to a parallel plan, four were wrapped, and the planner's choice for
 * the other sixty moves as the tables grow.
 *
 * So migration 0225 sets `max_parallel_workers_per_gather = 0` as the database
 * default and every connection inherits it. That migration is deliberately
 * fail-soft: `ALTER DATABASE ... SET` needs database ownership, and a deploy
 * role without it gets a warning rather than a blocked release.
 *
 * A warning in a migration log is precisely the kind of thing nobody reads —
 * five rounds of this bug stayed invisible for want of a signal. So the
 * backend reports the value its OWN pool sees on the health endpoints, and
 * these tests pin that reporting path end to end. If they are deleted, the fix
 * becomes unobservable, which is the failure mode that produced rounds 1-4.
 *
 * DB-free on purpose: it exercises the probe and the handlers through a fake
 * pool, so it runs on the shared backend suite without needing Postgres.
 */
import { describe, expect, it, beforeEach, vi } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

const pubsubMock = vi.hoisted(() => ({
  isRedisRequired: vi.fn(() => false),
  isRedisConnected: vi.fn(() => true),
}));

vi.mock('../pubsub/index', () => ({ pubsub: pubsubMock }));

import { handleDatabaseHealthCheck, handleHealthCheck } from '../handlers/health';
import { PROBE_SQL, probeDatabase, resetDbHealthState } from '../services/db-health';

/**
 * Records the statement it was handed, so the test can assert that the probe
 * actually asks Postgres for the setting rather than reporting a value it made
 * up locally.
 */
function fakePool() {
  const statements: string[] = [];
  const settlers: Array<(value: unknown) => void> = [];
  const pool = {
    unsafe(statement: string) {
      statements.push(statement);
      let settle: (value: unknown) => void = () => {};
      const promise = new Promise<unknown>((resolve) => {
        settle = resolve;
      });
      settlers.push(settle);
      return {
        then: (onFulfilled: unknown, onRejected: unknown) =>
          promise.then(onFulfilled as (value: unknown) => unknown, onRejected as (reason: unknown) => unknown),
        cancel: () => {},
      };
    },
    statements,
    settlers,
  };
  return pool;
}

function fakeResponse() {
  const state = { statusCode: 0, body: '', headers: {} as Record<string, string> };
  const res = {
    setHeader: () => {},
    writeHead: (statusCode: number, headers: Record<string, string> = {}) => {
      state.statusCode = statusCode;
      state.headers = headers;
      return res;
    },
    end: (chunk?: string) => {
      state.body = chunk ?? '';
      return res;
    },
    headersSent: false,
  };
  return { res: res as unknown as ServerResponse, state };
}

const fakeRequest = { method: 'GET', headers: {} } as unknown as IncomingMessage;

/** Primes the shared probe cache with one settled reading, the way the handler tests do. */
async function primeProbe(rows: unknown): Promise<ReturnType<typeof fakePool>> {
  const pool = fakePool();
  const pending = probeDatabase({ getPool: () => pool as never });
  pool.settlers[0]!(rows);
  await pending;
  return pool;
}

beforeEach(() => {
  resetDbHealthState();
  pubsubMock.isRedisRequired.mockReturnValue(false);
  pubsubMock.isRedisConnected.mockReturnValue(true);
});

describe('DSM parallel-plan default (#5352)', () => {
  describe('the probe asks Postgres for the setting', () => {
    it('reads max_parallel_workers_per_gather in the reachability statement', async () => {
      const pool = await primeProbe([{ ok: 1, mpwpg: '0' }]);

      // Without this column the health field below can only ever report null,
      // and the recurrence signal is blind.
      expect(pool.statements[0]).toContain('max_parallel_workers_per_gather');
      expect(PROBE_SQL).toContain('max_parallel_workers_per_gather');
    });

    it('keeps the reading on the existing round trip', async () => {
      const pool = await primeProbe([{ ok: 1, mpwpg: '0' }]);

      // /health is on the Railway healthcheck path. Reading the setting must
      // not cost a second statement.
      expect(pool.statements).toHaveLength(1);
    });
  });

  describe('the reported value is the one Postgres returned', () => {
    it('surfaces "0" when the database default applied', async () => {
      await expect(
        probeDatabase({ getPool: () => fakePoolSettledWith([{ ok: 1, mpwpg: '0' }]) as never }),
      ).resolves.toMatchObject({ maxParallelWorkersPerGather: '0' });
    });

    it('surfaces the real value when the default did NOT apply', async () => {
      // The whole point of the field: a database where migration 0225's
      // ALTER DATABASE was skipped still reports Postgres's own default, and
      // that is the signal that 53100 can come back.
      await expect(
        probeDatabase({ getPool: () => fakePoolSettledWith([{ ok: 1, mpwpg: '2' }]) as never }),
      ).resolves.toMatchObject({ maxParallelWorkersPerGather: '2' });
    });

    it('reports null rather than throwing when the row shape is unexpected', async () => {
      await expect(probeDatabase({ getPool: () => fakePoolSettledWith([]) as never })).resolves.toMatchObject({
        reachable: true,
        maxParallelWorkersPerGather: null,
      });
    });
  });

  describe('the health endpoints publish it', () => {
    it('GET /health/db carries maxParallelWorkersPerGather', async () => {
      await primeProbe([{ ok: 1, mpwpg: '0' }]);

      const { res, state } = fakeResponse();
      await handleDatabaseHealthCheck(fakeRequest, res);

      expect(state.statusCode).toBe(200);
      expect(JSON.parse(state.body).database.maxParallelWorkersPerGather).toBe('0');
    });

    it('GET /health carries it too', async () => {
      await primeProbe([{ ok: 1, mpwpg: '0' }]);

      const { res, state } = fakeResponse();
      await handleHealthCheck(fakeRequest, res);

      expect(JSON.parse(state.body).database.maxParallelWorkersPerGather).toBe('0');
    });

    it('shows a non-zero value through the endpoint, not just the probe', async () => {
      await primeProbe([{ ok: 1, mpwpg: '2' }]);

      const { res, state } = fakeResponse();
      await handleDatabaseHealthCheck(fakeRequest, res);

      expect(JSON.parse(state.body).database.maxParallelWorkersPerGather).toBe('2');
    });
  });

  describe('migration 0225 sets the database default', () => {
    const migrationPath = join(import.meta.dirname, '../../../db/drizzle/0225_dsm_serial_plan_default.sql');

    it('turns per-gather parallelism off at database scope', () => {
      const sql = readFileSync(migrationPath, 'utf8');

      // Database scope, not role scope: the sync daemons, SSR, OG-image and
      // cron paths share this /dev/shm and do not all connect as the app role.
      expect(sql).toMatch(/ALTER DATABASE %I SET max_parallel_workers_per_gather = 0/);
      expect(sql).toContain('current_database()');
    });

    it('is fail-soft on a deploy role that cannot ALTER DATABASE', () => {
      const sql = readFileSync(migrationPath, 'utf8');

      // A blocked release is worse than a reported miss — /health/db is what
      // turns the miss into something someone can see.
      expect(sql).toContain('insufficient_privilege');
      expect(sql).toContain('RAISE WARNING');
    });

    it('is registered in the drizzle journal', () => {
      const journal = JSON.parse(
        readFileSync(join(import.meta.dirname, '../../../db/drizzle/meta/_journal.json'), 'utf8'),
      ) as { entries: Array<{ tag: string }> };

      expect(journal.entries.map((entry) => entry.tag)).toContain('0225_dsm_serial_plan_default');
    });
  });
});

/** A pool whose single query is already settled — for the one-shot probe assertions. */
function fakePoolSettledWith(rows: unknown) {
  return {
    unsafe(_statement: string) {
      return {
        then: (onFulfilled: unknown, onRejected: unknown) =>
          Promise.resolve(rows).then(
            onFulfilled as (value: unknown) => unknown,
            onRejected as (reason: unknown) => unknown,
          ),
        cancel: () => {},
      };
    },
  };
}
