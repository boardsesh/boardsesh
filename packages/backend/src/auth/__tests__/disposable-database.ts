import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

function adminUrl(): URL {
  const databaseUrl = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
    databaseUrl.pathname !== '/postgres' ||
    databaseUrl.search.length > 0
  ) {
    throw new Error('Disposable databases require an explicit local Postgres admin URL ending in /postgres.');
  }
  return databaseUrl;
}

/** Each caller owns one blank database; existing databases are never migrated or emptied. */
export async function createDisposableDatabase() {
  const admin = adminUrl();
  const databaseName = `boardsesh_disposable_${randomUUID().replaceAll('-', '')}`;
  const adminClient = postgres(admin.toString(), {
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 15000, lock_timeout: 10000 },
    onnotice: () => {},
  });
  const databaseUrl = new URL(admin);
  databaseUrl.pathname = `/${databaseName}`;
  let databaseCreated = false;
  const close = async () => {
    try {
      if (databaseCreated) {
        // Generated identifier is fixed-prefix hexadecimal, never user-controlled.
        await adminClient.unsafe(`DROP DATABASE "${databaseName}"`);
        databaseCreated = false;
      }
    } finally {
      await adminClient.end({ timeout: 5 });
    }
  };
  try {
    await adminClient.unsafe(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    return { databaseUrl: databaseUrl.toString(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
