import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createDedicatedPool, withConnectRetry, type PoolInstance } from '@boardsesh/db/client';
import { logger } from '../utils/logger';
import { AUTH_ADMISSION_RESPONSE_DEADLINE_MS } from './admission-read-runner';

/** Connections per backend replica. Counted in docs/db-connectivity.md, "Connection budget". */
export const AUTH_ADMISSION_POOL_MAX_CONNECTIONS = 2;

/**
 * How long a statement may hold a connection. The server starts this clock when
 * the statement reaches it, so a read that queued first can outlast its caller's
 * deadline by as long as it queued.
 */
export const AUTH_ADMISSION_STATEMENT_TIMEOUT_MS = AUTH_ADMISSION_RESPONSE_DEADLINE_MS;

/**
 * The statement timeout needs a server that is still answering. A read with no
 * reply this long after reaching a connection has lost its socket, and `max: 2`
 * means nothing else can open a way round it.
 */
export const AUTH_ADMISSION_READ_WATCHDOG_MS = AUTH_ADMISSION_STATEMENT_TIMEOUT_MS + 1000;

/**
 * Least time between replacing the pool: 5 s, then 10, 20 and 60 s while no read
 * has answered. Each replacement can leave two hung backends on the server, so a
 * server whose new connections hang too gets fewer of them and cannot be pushed
 * to `max_connections`. An answered read starts the schedule again at 5 s.
 */
export const AUTH_ADMISSION_RECYCLE_BACKOFF_MS = [5000, 10_000, 20_000, 60_000] as const;

/**
 * Seconds to open a connection. Longer than the watchdog, so a primary that is
 * slow to open a connection can still be reached; shorter than the first gap
 * between replacements, so a dial ends before the next replacement could cut it
 * off. The cost: a dial swallowed by a dead path holds its slot this long.
 */
export const AUTH_ADMISSION_CONNECT_TIMEOUT_S = 4;

/**
 * Connect failures are retried only while the caller is still waiting. A dial
 * that timed out is already past the deadline, and retrying it only adds dials
 * to a primary that is struggling to open them.
 */
export const AUTH_ADMISSION_CONNECT_RETRY_BUDGET_MS = AUTH_ADMISSION_RESPONSE_DEADLINE_MS;

/** Lets the "count connections" query in docs/db-connectivity.md see this pool. */
export const AUTH_ADMISSION_APPLICATION_NAME = 'boardsesh-auth-admission';

/** Seconds before a shutdown severs what is still open, well inside the force-exit timer. */
const AUTH_ADMISSION_POOL_CLOSE_TIMEOUT_S = 2;

export class AdmissionReadStalledError extends Error {
  readonly code = 'ADMISSION_READ_STALLED';

  constructor() {
    super('Admission read stopped answering');
    this.name = 'AdmissionReadStalledError';
  }
}

type AdmissionConnections = {
  pool: PoolInstance;
  database: PostgresJsDatabase;
  /** When a read on this pool last got an answer. */
  lastAnsweredAt: number;
};

let connections: AdmissionConnections | undefined;
let lastRecycledAt = Number.NEGATIVE_INFINITY;
let replacementsSinceAnswer = 0;

/**
 * Opened on the first read, so a process that imports this module and never
 * admits anyone never connects. Primary only: a lagging replica must never
 * decide admission.
 */
function admissionConnections(): AdmissionConnections {
  if (connections) return connections;
  const pool = createDedicatedPool(AUTH_ADMISSION_POOL_MAX_CONNECTIONS, {
    connect_timeout: AUTH_ADMISSION_CONNECT_TIMEOUT_S,
    // Replaces any DB_STATEMENT_TIMEOUT_MS for this pool only.
    connection: {
      statement_timeout: AUTH_ADMISSION_STATEMENT_TIMEOUT_MS,
      application_name: AUTH_ADMISSION_APPLICATION_NAME,
    },
  });
  connections = {
    pool,
    database: drizzle(withConnectRetry(pool, { budgetMs: AUTH_ADMISSION_CONNECT_RETRY_BUDGET_MS })),
    lastAnsweredAt: Number.NEGATIVE_INFINITY,
  };
  return connections;
}

export function getAdmissionPool(): PoolInstance {
  return admissionConnections().pool;
}

export async function closeAdmissionPool(): Promise<void> {
  const closingPool = connections?.pool;
  connections = undefined;
  lastRecycledAt = Number.NEGATIVE_INFINITY;
  replacementsSinceAnswer = 0;
  await closingPool?.end({ timeout: AUTH_ADMISSION_POOL_CLOSE_TIMEOUT_S });
}

/**
 * Severs a pool whose read stopped answering, so the next read dials afresh.
 * Reads already on it fail, and they are past their deadline by now.
 */
function recycleStalledPool(stalled: AdmissionConnections, stalledReadStartedAt: number): void {
  // Another read on the same pool, or a shutdown, already dealt with it.
  if (connections !== stalled) return;
  // postgres.js opens the second connection only when the first is busy. A read
  // waiting on that dial outlives the watchdog when opening is slow, while the
  // first connection keeps answering. Severing would cut both.
  if (stalled.lastAnsweredAt >= stalledReadStartedAt) return;
  const now = performance.now();
  const backoffStep = Math.min(Math.max(replacementsSinceAnswer - 1, 0), AUTH_ADMISSION_RECYCLE_BACKOFF_MS.length - 1);
  if (now - lastRecycledAt < AUTH_ADMISSION_RECYCLE_BACKOFF_MS[backoffStep]) return;
  lastRecycledAt = now;
  replacementsSinceAnswer += 1;
  connections = undefined;
  stalled.pool.end({ timeout: 0 }).catch(() => undefined);
  logger.warn('[auth-admission] replaced the pool after a read stopped answering', {
    watchdogMs: AUTH_ADMISSION_READ_WATCHDOG_MS,
    replacementsSinceAnswer,
  });
}

let busyConnections = 0;
const waitingReads: Array<() => void> = [];

function acquireConnection(): Promise<void> {
  if (busyConnections < AUTH_ADMISSION_POOL_MAX_CONNECTIONS) {
    busyConnections += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitingReads.push(resolve));
}

function releaseConnection(): void {
  const nextRead = waitingReads.shift();
  if (nextRead) nextRead();
  else busyConnections -= 1;
}

/**
 * Runs one read when a connection is free, in arrival order. postgres.js does
 * not say when a queued statement reaches a connection, so reads queue here
 * instead of in the driver and `onConnection` marks that moment.
 */
export async function readOnAdmissionConnection<Result>(
  onConnection: () => void,
  read: (admissionDatabase: PostgresJsDatabase) => PromiseLike<Result>,
): Promise<Result> {
  await acquireConnection();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    onConnection();
    const readStartedAt = performance.now();
    const readConnections = admissionConnections();
    const answer = await Promise.race([
      read(readConnections.database),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          recycleStalledPool(readConnections, readStartedAt);
          reject(new AdmissionReadStalledError());
        }, AUTH_ADMISSION_READ_WATCHDOG_MS);
      }),
    ]);
    readConnections.lastAnsweredAt = performance.now();
    replacementsSinceAnswer = 0;
    return answer;
  } finally {
    clearTimeout(watchdog);
    releaseConnection();
  }
}
