import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createDedicatedPool, withConnectRetry, type PoolInstance } from '@boardsesh/db/client';
import { AUTH_ADMISSION_RESPONSE_DEADLINE_MS } from './admission-read-runner';

/** Connections per backend replica. Counted in docs/db-connectivity.md, "Connection budget". */
export const AUTH_ADMISSION_POOL_MAX_CONNECTIONS = 2;

/** A read past the caller's deadline has nobody left to answer, so the server drops it there. */
export const AUTH_ADMISSION_STATEMENT_TIMEOUT_MS = AUTH_ADMISSION_RESPONSE_DEADLINE_MS;

/** Lets the "count connections" query in docs/db-connectivity.md see this pool. */
export const AUTH_ADMISSION_APPLICATION_NAME = 'boardsesh-auth-admission';

/** Seconds before a shutdown severs what is still open, well inside the force-exit timer. */
const AUTH_ADMISSION_POOL_CLOSE_TIMEOUT_S = 2;

type AdmissionConnections = { pool: PoolInstance; database: PostgresJsDatabase };

let connections: AdmissionConnections | undefined;

/**
 * Opened on the first read, so a process that imports this module and never
 * admits anyone never connects. Primary only: a lagging replica must never
 * decide admission.
 */
function admissionConnections(): AdmissionConnections {
  if (connections) return connections;
  const pool = createDedicatedPool(AUTH_ADMISSION_POOL_MAX_CONNECTIONS);
  // postgres.js sends options.connection each time a connection opens, and none
  // has yet. This replaces any DB_STATEMENT_TIMEOUT_MS for this pool only.
  pool.options.connection.statement_timeout = AUTH_ADMISSION_STATEMENT_TIMEOUT_MS;
  pool.options.connection.application_name = AUTH_ADMISSION_APPLICATION_NAME;
  connections = { pool, database: drizzle(withConnectRetry(pool)) };
  return connections;
}

export function getAdmissionPool(): PoolInstance {
  return admissionConnections().pool;
}

export async function closeAdmissionPool(): Promise<void> {
  const closingPool = connections?.pool;
  connections = undefined;
  await closingPool?.end({ timeout: AUTH_ADMISSION_POOL_CLOSE_TIMEOUT_S });
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
  try {
    onConnection();
    return await read(admissionConnections().database);
  } finally {
    releaseConnection();
  }
}
