import { createPool } from '@boardsesh/db/client';
import type { DbConnectRetryEvent, PoolInstance } from '@boardsesh/db/client';

export type DatabaseHealth = {
  reachable: boolean;
  /** Round-trip time of the probe, or null when it never came back. */
  latencyMs: number | null;
  checkedAt: number;
  /** Error code (or a short message) — never the SQL or the connection string. */
  error: string | null;
  /**
   * The session's effective `max_parallel_workers_per_gather`, as Postgres
   * reports it — `'0'` when migration 0225 applied, null when the probe could
   * not read it.
   *
   * This is the recurrence signal for the DSM saga (#5352, and #2378 / #3856 /
   * #4105 / #4235 / #4528 before it). `could not resize shared memory segment
   * ... No space left on device` (SQLSTATE 53100) is a parallel-query failure:
   * Postgres could not get the dynamic shared memory a parallel worker needs out
   * of the container's /dev/shm. With per-gather parallelism off, no statement on
   * this connection can plan a Gather, so none of them can raise it.
   *
   * 0225 sets that default on the database, but it is deliberately fail-soft —
   * `ALTER DATABASE ... SET` needs database ownership, and a deploy role without
   * it gets a warning rather than a blocked release. A warning in a migration log
   * is exactly the kind of thing nobody reads, which is how five rounds of this
   * bug stayed invisible. So the effective value is reported here instead: if
   * this is not `'0'` in production, the default did not land and 53100 can come
   * back.
   */
  maxParallelWorkersPerGather: string | null;
};

export type DbConnectRetryStats = {
  count: number;
  lastRetryAt: number | null;
  lastCode: string | null;
};

/**
 * Result cache. /health is polled by the Railway healthcheck, the Docker
 * HEALTHCHECK and any external monitor; without a TTL each of those would put
 * another `select 1` on the pool, and during an outage the probes would occupy
 * pool slots and then all fire at once on recovery.
 */
const PROBE_TTL_MS = 5_000;
/** Hard ceiling on how long /health can wait behind a dead pool. */
const PROBE_DEADLINE_MS = 2_000;

/**
 * The reachability probe, plus the one GUC that decides whether this connection
 * can hit the DSM exhaustion of #5352. Deliberately one statement: the probe is
 * on the Railway healthcheck path, so reading the setting must not cost a second
 * round trip. `current_setting` is a local lookup — it adds no measurable time to
 * the `select 1`.
 */
export const PROBE_SQL = "select 1 as ok, current_setting('max_parallel_workers_per_gather') as mpwpg";

/**
 * postgres.js hands back an array of row objects. Read defensively: a driver or
 * pool double in a test may return something else, and a health probe must never
 * be the thing that throws.
 */
function readMaxParallelWorkersPerGather(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (!first || typeof first !== 'object') return null;
  const { mpwpg } = first as { mpwpg?: unknown };
  return typeof mpwpg === 'string' ? mpwpg : null;
}

type ProbeOptions = {
  ttlMs?: number;
  deadlineMs?: number;
  now?: () => number;
  getPool?: () => PoolInstance;
};

let cachedHealth: DatabaseHealth | null = null;
let inFlightProbe: Promise<DatabaseHealth> | null = null;

let retryStats: DbConnectRetryStats = { count: 0, lastRetryAt: null, lastCode: null };

export function recordDbConnectRetry(event: DbConnectRetryEvent, now: () => number = Date.now): void {
  retryStats = { count: retryStats.count + 1, lastRetryAt: now(), lastCode: event.code };
}

export function getDbConnectRetryStats(): DbConnectRetryStats {
  return retryStats;
}

/** Test seam — drops the cached probe result and the retry counters. */
export function resetDbHealthState(): void {
  cachedHealth = null;
  inFlightProbe = null;
  retryStats = { count: 0, lastRetryAt: null, lastCode: null };
}

/**
 * Reports whether Postgres answers a `select 1`. Cached for `PROBE_TTL_MS` and
 * de-duplicated across concurrent callers, so a burst of health checks costs at
 * most one query.
 */
export function probeDatabase(options: ProbeOptions = {}): Promise<DatabaseHealth> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PROBE_TTL_MS;

  if (cachedHealth && now() - cachedHealth.checkedAt < ttlMs) {
    return Promise.resolve(cachedHealth);
  }
  if (inFlightProbe) {
    return inFlightProbe;
  }

  const pending = runProbe(options)
    .then((health) => {
      cachedHealth = health;
      return health;
    })
    .finally(() => {
      if (inFlightProbe === pending) {
        inFlightProbe = null;
      }
    });
  inFlightProbe = pending;
  return pending;
}

async function runProbe(options: ProbeOptions): Promise<DatabaseHealth> {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  const startedAt = now();

  let query: ReturnType<PoolInstance['unsafe']>;
  try {
    const pool = (options.getPool ?? createPool)();
    // `current_setting` rides along on the existing probe rather than costing a
    // second round trip, and the result is cached for PROBE_TTL_MS like the rest
    // of the probe. See DatabaseHealth.maxParallelWorkersPerGather for why the
    // value is worth reporting at all.
    query = pool.unsafe(PROBE_SQL);
  } catch (error) {
    return {
      reachable: false,
      latencyMs: null,
      checkedAt: now(),
      error: describeError(error),
      maxParallelWorkersPerGather: null,
    };
  }

  // Handle the rejection inside the race, so cancelling the query below can
  // never surface as an unhandled rejection.
  const settled = query.then(
    (rows: unknown) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([settled, deadline]);

    if (outcome === 'timeout') {
      // postgres.js queues a query with no timeout of its own
      // (postgres/src/index.js:341). Walking away from the promise would leave
      // a zombie `select 1` in the queue that fires whenever the pool
      // recovers, so probes would pile up through an outage. cancel() takes it
      // back out of the queue (index.js:350-360).
      cancelQuietly(query);
      return {
        reachable: false,
        latencyMs: null,
        checkedAt: now(),
        error: `probe exceeded ${deadlineMs}ms`,
        maxParallelWorkersPerGather: null,
      };
    }

    if (!outcome.ok) {
      return {
        reachable: false,
        latencyMs: null,
        checkedAt: now(),
        error: describeError(outcome.error),
        maxParallelWorkersPerGather: null,
      };
    }

    return {
      reachable: true,
      latencyMs: now() - startedAt,
      checkedAt: now(),
      error: null,
      maxParallelWorkersPerGather: readMaxParallelWorkersPerGather(outcome.rows),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cancelQuietly(query: ReturnType<PoolInstance['unsafe']>): void {
  try {
    // Typed `void`, but postgres.js actually hands back a promise when the
    // query already reached the server, so swallow its rejection too.
    const cancelled: unknown = query.cancel();
    if (cancelled && typeof (cancelled as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(cancelled).catch(() => {});
    }
  } catch {
    // Cancelling is best effort; a failure here must not fail the probe.
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && code.length > 0) return code;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 200);
  }
  return 'unknown error';
}
