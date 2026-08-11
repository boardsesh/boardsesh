import { createPool } from '@boardsesh/db/client';
import type { DbConnectRetryEvent, PoolInstance } from '@boardsesh/db/client';

export type DatabaseHealth = {
  reachable: boolean;
  /** Round-trip time of the `select 1`, or null when it never came back. */
  latencyMs: number | null;
  checkedAt: number;
  /** Error code (or a short message) — never the SQL or the connection string. */
  error: string | null;
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
    query = pool.unsafe('select 1');
  } catch (error) {
    return { reachable: false, latencyMs: null, checkedAt: now(), error: describeError(error) };
  }

  // Handle the rejection inside the race, so cancelling the query below can
  // never surface as an unhandled rejection.
  const settled = query.then(
    () => ({ ok: true as const }),
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
      };
    }

    if (!outcome.ok) {
      return { reachable: false, latencyMs: null, checkedAt: now(), error: describeError(outcome.error) };
    }

    return { reachable: true, latencyMs: now() - startedAt, checkedAt: now(), error: null };
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
