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
 * Least time between replacing the pool: 5 s, then 10 s, then 20 s for as long as
 * reads keep stalling. Each replacement can leave two hung backends on the
 * server, so a server whose new connections hang too gets fewer of them and
 * cannot be pushed to `max_connections`. 20 s is also the longest a path that
 * has healed can wait behind a pool that hung before it healed.
 *
 * The schedule starts again at 5 s only after a whole gap with no stalled read.
 * Neither an answered read nor a connection that opens counts: a server whose
 * new connections answer for a moment and then hang does both.
 */
export const AUTH_ADMISSION_RECYCLE_BACKOFF_MS = [5000, 10_000, 20_000] as const;

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

/**
 * A read waiting on a slow dial settles within the connect timeout plus the
 * statement timeout. One still unsettled this long after it began, on a pool that
 * kept answering other reads, is on a dead socket beside a healthy one.
 */
export const AUTH_ADMISSION_DEAD_SOCKET_AFTER_MS =
  AUTH_ADMISSION_CONNECT_TIMEOUT_S * 1000 + AUTH_ADMISSION_STATEMENT_TIMEOUT_MS + 2000;

/** Seconds a pool replaced for one dead socket keeps going, so reads on its healthy connection finish. */
export const AUTH_ADMISSION_REPLACEMENT_GRACE_S = 1;

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

/** A read on a connection, tracked past its caller's watchdog. */
type ReadProgress = { startedAt: number; isSettled: boolean };

let connections: AdmissionConnections | undefined;
let lastRecycledAt = Number.NEGATIVE_INFINITY;
let lastStalledAt = Number.NEGATIVE_INFINITY;
let replacementsInSequence = 0;

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
  lastStalledAt = Number.NEGATIVE_INFINITY;
  replacementsInSequence = 0;
  await closingPool?.end({ timeout: AUTH_ADMISSION_POOL_CLOSE_TIMEOUT_S });
}

function replacementGapMs(): number {
  const step = Math.min(Math.max(replacementsInSequence - 1, 0), AUTH_ADMISSION_RECYCLE_BACKOFF_MS.length - 1);
  return AUTH_ADMISSION_RECYCLE_BACKOFF_MS[step];
}

/** A whole gap with no stalled read means the path recovered, so the schedule starts again. */
function noteStalledRead(now: number): void {
  if (now - lastStalledAt >= replacementGapMs()) replacementsInSequence = 0;
  lastStalledAt = now;
}

/**
 * Severs a pool so the next read dials afresh, unless the backoff says wait.
 * Reads still on it fail once the grace runs out.
 */
function replacePool(stalled: AdmissionConnections, graceSeconds: number): boolean {
  const now = performance.now();
  if (now - lastRecycledAt < replacementGapMs()) return false;
  lastRecycledAt = now;
  replacementsInSequence += 1;
  connections = undefined;
  stalled.pool.end({ timeout: graceSeconds }).catch(() => undefined);
  logger.warn('[auth-admission] replaced the pool after a read stopped answering', {
    watchdogMs: AUTH_ADMISSION_READ_WATCHDOG_MS,
    replacementsInSequence,
  });
  return true;
}

function handleStalledRead(stalled: AdmissionConnections, read: ReadProgress): void {
  noteStalledRead(performance.now());
  // Another read on the same pool, or a shutdown, already dealt with it.
  if (connections !== stalled) return;
  // Nothing on this pool has answered since the read began: nothing on it reaches Postgres.
  if (stalled.lastAnsweredAt <= read.startedAt) {
    replacePool(stalled, 0);
    return;
  }
  // postgres.js opens the second connection only when the first is busy, so the
  // read may be waiting on a slow dial while the first connection answers, and
  // severing now would cut both. Give the dial the time it can take.
  checkForDeadSocket(stalled, read, read.startedAt + AUTH_ADMISSION_DEAD_SOCKET_AFTER_MS - performance.now());
}

function checkForDeadSocket(stalled: AdmissionConnections, read: ReadProgress, delayMs: number): void {
  setTimeout(
    () => {
      if (read.isSettled || connections !== stalled) return;
      const now = performance.now();
      noteStalledRead(now);
      if (replacePool(stalled, AUTH_ADMISSION_REPLACEMENT_GRACE_S)) return;
      checkForDeadSocket(stalled, read, lastRecycledAt + replacementGapMs() - now);
    },
    Math.max(0, delayMs),
  ).unref();
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
    const progress: ReadProgress = { startedAt: performance.now(), isSettled: false };
    const readConnections = admissionConnections();
    const pendingRead = Promise.resolve(read(readConnections.database));
    const markSettled = () => {
      progress.isSettled = true;
    };
    pendingRead.then(markSettled, markSettled);
    const answer = await Promise.race([
      pendingRead,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          handleStalledRead(readConnections, progress);
          reject(new AdmissionReadStalledError());
        }, AUTH_ADMISSION_READ_WATCHDOG_MS);
      }),
    ]);
    readConnections.lastAnsweredAt = performance.now();
    return answer;
  } finally {
    clearTimeout(watchdog);
    releaseConnection();
  }
}
