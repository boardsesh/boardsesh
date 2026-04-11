import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzleServerless, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import type { Logger } from 'drizzle-orm';
import postgres from 'postgres';
import ws from 'ws';
import { getConnectionConfig, configureNeonForEnvironment, isTestEnvironment } from './config';
import * as schema from '../schema/index';
import * as relations from '../relations/index';

// Query logger enabled via DEBUG_SQL=true — logs all queries with execution time
class QueryLogger implements Logger {
  logQuery(query: string, params: unknown[]): void {
    const timestamp = new Date().toISOString();
    console.log(`[SQL ${timestamp}] ${query}`);
    if (params.length > 0) {
      console.log(`[SQL params] ${JSON.stringify(params)}`);
    }
  }
}

const sqlLogger = process.env.DEBUG_SQL === 'true' ? new QueryLogger() : undefined;

// Configure WebSocket constructor
neonConfig.webSocketConstructor = ws;

// Combine schema and relations for full Drizzle support
const fullSchema = { ...schema, ...relations };

// Singleton instances.
//
// These back `createDb()` / `createPool()`, which are used by:
//  - the Next.js web package (via `getDb` / `getPool` re-exports) for its
//    route handlers and sync workers,
//  - the `aurora-sync` CLI, which explicitly creates a long-lived pool for
//    batch sync runs,
//  - Vitest test suites, where `createDb()` returns a `postgres-js` client
//    bound to the local test Postgres.
//
// The backend service intentionally does NOT consume these singletons in
// production: it uses `createRequestDb()` (stateless neon-http) for reads
// and `withTransaction()` (ephemeral pool that closes immediately) for
// writes, so the Neon compute can spin down while the service idles. Do
// not reintroduce the singletons into the backend request path.
let pool: Pool | null = null;
let postgresClient: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzleServerless> | ReturnType<typeof drizzlePostgres> | null = null;

export function createPool(): Pool {
  if (!pool) {
    configureNeonForEnvironment();
    const { connectionString } = getConnectionConfig();
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 30000, // 30s to establish connection
      idleTimeoutMillis: 120000, // 2 min idle before closing
      max: 10, // max connections in pool
    });
  }
  return pool;
}

export function createDb() {
  if (!db) {
    const { connectionString, isTest } = getConnectionConfig();

    if (isTest) {
      // Use postgres-js directly for tests (no Neon proxy needed)
      postgresClient = postgres(connectionString);
      db = drizzlePostgres(postgresClient, { schema: fullSchema, logger: sqlLogger });
    } else {
      // Use Neon serverless for production/development
      const poolInstance = createPool();
      db = drizzleServerless(poolInstance, { schema: fullSchema, logger: sqlLogger });
    }
  }
  return db;
}

export function createNeonHttp() {
  configureNeonForEnvironment();
  const { connectionString } = getConnectionConfig();
  const sql = neon(connectionString);
  return drizzleHttp({ client: sql, schema: fullSchema, logger: sqlLogger });
}

export function createRequestDb() {
  const { isTest } = getConnectionConfig();
  if (isTest) {
    return createDb() as unknown as ReturnType<typeof createNeonHttp>;
  }

  configureNeonForEnvironment();
  const { connectionString } = getConnectionConfig();
  const sql = neon(connectionString);
  return drizzleHttp({ client: sql, schema: fullSchema, logger: sqlLogger });
}

/**
 * Run a callback inside a Postgres transaction.
 *
 * The neon-http driver we use for request-scoped reads/writes cannot run
 * callback-style transactions (it only supports atomic batches). This helper
 * creates an **ephemeral** WebSocket pool for the duration of the callback,
 * runs the transaction on it, and closes the pool immediately. No long-lived
 * connection is held, so the Neon compute can still spin down between
 * transactions.
 *
 * In tests we fall back to the process-wide postgres-js singleton returned
 * by `createDb()`, which supports real transactions against the test database.
 */
export async function withTransaction<T>(
  fn: (tx: Parameters<Parameters<NeonDatabase<typeof fullSchema>['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  const { isTest } = getConnectionConfig();

  if (isTest) {
    const testDb = createDb() as unknown as NeonDatabase<typeof fullSchema>;
    return testDb.transaction(fn);
  }

  configureNeonForEnvironment();
  const { connectionString } = getConnectionConfig();
  const ephemeralPool = new Pool({
    connectionString,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 1, // close sockets as soon as the tx finishes
    max: 1,
  });
  try {
    const txDb = drizzleServerless(ephemeralPool, { schema: fullSchema, logger: sqlLogger });
    return await txDb.transaction(fn);
  } finally {
    // Always close the ephemeral pool so no connection lingers against Neon.
    await ephemeralPool.end().catch((err) => {
      console.warn('[withTransaction] Failed to close ephemeral pool:', err);
    });
  }
}

/**
 * Concrete pooled/postgres-js client returned by `createDb()`. Used by the
 * Next.js web package, the aurora-sync CLI, and Vitest fixtures.
 */
export type DbInstance = ReturnType<typeof createDb>;

/**
 * Stateless neon-http drizzle client returned by `createRequestDb()`. Used by
 * the backend for all request-scoped reads/writes.
 */
export type RequestDbInstance = ReturnType<typeof createRequestDb>;

/**
 * Any drizzle client shape this codebase might hand to a shared query
 * helper. Shared helpers under `@boardsesh/db/queries` accept this so the
 * backend (neon-http) and the web package / CLIs (pooled or postgres-js)
 * can both invoke them without casts.
 */
export type AnyDbInstance = DbInstance | RequestDbInstance;

export type PoolInstance = Pool;
export type TransactionDb = Parameters<Parameters<NeonDatabase<typeof fullSchema>['transaction']>[0]>[0];
