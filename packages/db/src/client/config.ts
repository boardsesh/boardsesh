import { neonConfig } from '@neondatabase/serverless';

export interface ConnectionConfig {
  connectionString: string;
  isLocal: boolean;
  isTest: boolean;
}

export function isLocalDevelopment(): boolean {
  return process.env.VERCEL_ENV === 'development' ||
         process.env.NODE_ENV === 'development';
}

export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' ||
         process.env.VITEST === 'true';
}

export function getConnectionConfig(): ConnectionConfig {
  const connectionString = process.env.DATABASE_URL;
  const isLocal = isLocalDevelopment();
  const isTest = isTestEnvironment();

  // Use DATABASE_URL as-is if provided
  // Only fall back to local Docker database if DATABASE_URL is not set and in local development
  if (!connectionString && isLocal && !isTest) {
    return {
      connectionString: 'postgres://postgres:password@db.localtest.me:5432/main',
      isLocal,
      isTest,
    };
  }

  // Test fallback: mirror the default used by packages/backend/src/__tests__/setup.ts
  // so Vitest runs can hit the local test Postgres without requiring DATABASE_URL.
  if (!connectionString && isTest) {
    return {
      connectionString: 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test',
      isLocal,
      isTest,
    };
  }

  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return { connectionString, isLocal, isTest };
}

export function configureNeonForEnvironment(): void {
  const { connectionString } = getConnectionConfig();
  const connectionStringUrl = new URL(connectionString);
  const isLocalDb = connectionStringUrl.hostname === 'db.localtest.me';

  // Apply Neon proxy settings for local Docker database
  if (isLocalDb) {
    neonConfig.fetchEndpoint = () => `http://${connectionStringUrl.hostname}:4444/sql`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.wsProxy = () => `${connectionStringUrl.hostname}:4444/v2`;
  }
}
