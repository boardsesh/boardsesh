import postgres from 'postgres';
import { pathToFileURL } from 'node:url';
import { scriptDatabaseConnectionOptions } from './db-connection.js';
import {
  assertExpectedDirectEndpoint,
  DIRECT_DATABASE_PROBE_TIMEOUT_MS,
  verifyDirectConnectivity,
} from './direct-database-guard.js';

export async function verifyDirectDatabase(): Promise<void> {
  const connectionString = process.env.MIGRATOR_DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATOR_DATABASE_URL is required; migrations must bypass PgBouncer transaction pooling');
  }
  assertExpectedDirectEndpoint(connectionString, process.env.DATABASE_DIRECT_ENDPOINT ?? '');

  const client = postgres(connectionString, {
    connect_timeout: 15,
    connection: { statement_timeout: DIRECT_DATABASE_PROBE_TIMEOUT_MS },
    onnotice: () => {},
    prepare: false,
    ...scriptDatabaseConnectionOptions(connectionString),
  });

  try {
    await verifyDirectConnectivity(client);
    console.info('Verified MIGRATOR_DATABASE_URL reaches PostgreSQL directly');
  } finally {
    await client.end({ timeout: 5 }).catch(() => {
      console.warn('Direct migration endpoint probe connection cleanup failed');
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void verifyDirectDatabase().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Direct migration endpoint verification failed');
    process.exitCode = 1;
  });
}
