import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { BetterAuthOptions } from 'better-auth';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority } from './authority';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../db/auth-prototype-migrations', import.meta.url));

function prototypeAdminUrl(): URL {
  const databaseUrl = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
    databaseUrl.pathname !== '/postgres' ||
    databaseUrl.search.length > 0
  ) {
    throw new Error('The auth prototype requires an explicit local Postgres admin URL ending in /postgres.');
  }
  return databaseUrl;
}

/** Each caller owns one blank database; existing databases are never migrated or emptied. */
export async function createPrototypeEnvironment(overrides: BetterAuthOptions = {}) {
  const adminUrl = prototypeAdminUrl();
  const databaseName = `boardsesh_ba01_${randomUUID().replaceAll('-', '')}`;
  const adminClient = postgres(adminUrl.toString(), {
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 15000, lock_timeout: 10000 },
    onnotice: () => {},
  });
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  let databaseCreated = false;
  const client = postgres(databaseUrl.toString(), { max: 8, onnotice: () => {} });

  const close = async () => {
    await client.end({ timeout: 5 });
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
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    const createAuthority = (authorityOverrides: BetterAuthOptions = {}) =>
      createPrototypeAuthority(database, { ...overrides, ...authorityOverrides });
    const auth = createAuthority();
    const secondaryAuth = createAuthority();
    // Plugin initialization seeds resource rows asynchronously. Finish both
    // initializers before tests can tear down the database they own.
    await Promise.all([auth.$context, secondaryAuth.$context]);
    return {
      auth,
      secondaryAuth,
      database,
      databaseUrl: databaseUrl.toString(),
      schema,
      createAuthority,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
