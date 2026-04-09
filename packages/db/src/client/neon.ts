import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzleServerless } from 'drizzle-orm/neon-serverless';
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

// Singleton instances
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

export type DbInstance = ReturnType<typeof createDb>;
export type RequestDbInstance = ReturnType<typeof createRequestDb>;
export type PoolInstance = Pool;
