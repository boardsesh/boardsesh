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

/** At most one replacement pool in this long, so a server that keeps hanging is not redialled in a loop. */
export const AUTH_ADMISSION_MIN_RECYCLE_INTERVAL_MS = 5000;

/** Seconds to open a connection. A stalled dial or TLS handshake would hold a slot for the shared 30. */
export const AUTH_ADMISSION_CONNECT_TIMEOUT_S = 2;

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

type AdmissionConnections = { pool: PoolInstance; database: PostgresJsDatabase };

let connections: AdmissionConnections | undefined;
let lastRecycledAt = Number.NEGATIVE_INFINITY;

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
  connections = { pool, database: drizzle(withConnectRetry(pool)) };
  return connections;
}

export function getAdmissionPool(): PoolInstance {
  return admissionConnections().pool;
}

export async function closeAdmissionPool(): Promise<void> {
  const closingPool = connections?.pool;
  connections = undefined;
  lastRecycledAt = Number.NEGATIVE_INFINITY;
  await closingPool?.end({ timeout: AUTH_ADMISSION_POOL_CLOSE_TIMEOUT_S });
}

/**
 * Severs a pool whose read stopped answering, so the next read dials afresh.
 * Reads already on it fail, and they are past their deadline by now.
 */
function recycleStalledPool(stalled: AdmissionConnections): void {
  // Another read on the same pool, or a shutdown, already dealt with it.
  if (connections !== stalled) return;
  const now = performance.now();
  if (now - lastRecycledAt < AUTH_ADMISSION_MIN_RECYCLE_INTERVAL_MS) return;
  lastRecycledAt = now;
  connections = undefined;
  stalled.pool.end({ timeout: 0 }).catch(() => undefined);
  logger.warn('[auth-admission] replaced the pool after a read stopped answering', {
    watchdogMs: AUTH_ADMISSION_READ_WATCHDOG_MS,
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
    const readConnections = admissionConnections();
    return await Promise.race([
      read(readConnections.database),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          recycleStalledPool(readConnections);
          reject(new AdmissionReadStalledError());
        }, AUTH_ADMISSION_READ_WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    releaseConnection();
  }
}
