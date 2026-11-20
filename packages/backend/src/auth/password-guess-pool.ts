import { createDbOnPool, createDedicatedPool, type DbInstance, type PoolInstance } from '@boardsesh/db/client';
import { PASSWORD_GUESS_DEADLINE_MS } from './password-guess-windows';

/**
 * The password guess counter's own connections (#7656). Not the shared primary
 * pool: that pool has 5 connections, and anyone able to keep it busy would push
 * every reserve past its 250 ms deadline, where the counter fails open. Here the
 * counter only queues behind other counter work, which the in-flight cap bounds.
 */
export const PASSWORD_GUESS_POOL_MAX_ENV = 'AUTH_ACCOUNT_GUESS_LIMIT_POOL_MAX';
/** Connections per backend replica. Counted in docs/operations/db-connectivity.md, "Connection budget". */
/**
 * One by default: with the mode on it adds 1 connection per replica (2 steady,
 * 4 while an old fleet drains), which the connection budget can carry.
 */
export const PASSWORD_GUESS_POOL_DEFAULT_MAX = 1;
const PASSWORD_GUESS_POOL_LARGEST_MAX = 4;
/** Lets the "count connections" query in docs/operations/db-connectivity.md see this pool. */
export const PASSWORD_GUESS_APPLICATION_NAME = 'boardsesh-auth-guess-limit';
/** A dial slower than this cannot help a caller that gives up at 250 ms. */
const CONNECT_TIMEOUT_S = 2;
/** A backstop above each transaction's own deadline, for a statement that escaped it. */
const STATEMENT_TIMEOUT_MS = PASSWORD_GUESS_DEADLINE_MS * 4;
const CLOSE_TIMEOUT_S = 2;

type Environment = Readonly<Record<string, string | undefined>>;

/** Unset or empty is the default. Anything but a whole number from 1 to 4 is a startup error. */
export function passwordGuessPoolMax(environment: Environment = process.env): number {
  const raw = environment[PASSWORD_GUESS_POOL_MAX_ENV];
  if (raw === undefined || raw === '') return PASSWORD_GUESS_POOL_DEFAULT_MAX;
  const max = Number(raw);
  if (!/^\d+$/.test(raw) || max < 1 || max > PASSWORD_GUESS_POOL_LARGEST_MAX)
    throw new Error(`Invalid ${PASSWORD_GUESS_POOL_MAX_ENV}`);
  return max;
}

let connections: { readonly pool: PoolInstance; readonly database: DbInstance } | undefined;

/** Opened on first use, so a backend with the limit off never connects. Primary only. */
export function passwordGuessDatabase(): DbInstance {
  if (connections) return connections.database;
  const pool = createDedicatedPool(passwordGuessPoolMax(), {
    connect_timeout: CONNECT_TIMEOUT_S,
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS, application_name: PASSWORD_GUESS_APPLICATION_NAME },
  });
  connections = { pool, database: createDbOnPool(pool, { logger: false }) };
  return connections.database;
}

export async function closePasswordGuessPool(): Promise<void> {
  const closing = connections?.pool;
  connections = undefined;
  await closing?.end({ timeout: CLOSE_TIMEOUT_S });
}
