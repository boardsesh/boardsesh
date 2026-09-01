import postgres from 'postgres';
import { assertExpectedDirectEndpoint, verifyDirectConnectivity } from './direct-database-guard';

async function verifyDirectDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_DIRECT_URL;
  if (!connectionString) {
    throw new Error('DATABASE_DIRECT_URL is required; migrations must bypass PgBouncer transaction pooling');
  }
  assertExpectedDirectEndpoint(connectionString, process.env.DATABASE_DIRECT_ENDPOINT ?? '');

  const client = postgres(connectionString, {
    connect_timeout: 15,
    max: 1,
    onnotice: () => {},
    prepare: false,
    ssl: 'require',
  });

  try {
    await verifyDirectConnectivity(client);
    console.info('Verified DATABASE_DIRECT_URL reaches PostgreSQL directly');
  } finally {
    await client.end({ timeout: 5 });
  }
}

void verifyDirectDatabase();
