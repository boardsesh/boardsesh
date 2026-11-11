import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schemaSQL } from '../../../__tests__/schema-sql';
import * as schema from '@boardsesh/db/schema';
import { createAuthority } from '../authority';

export const configuration = {
  baseURL: 'https://auth.boardsesh.test',
  secret: 'boardsesh-isolated-authority-test-secret-6975',
  trustedOrigins: ['https://auth.boardsesh.test'],
};

/** Only a fresh, suite-owned localhost database may receive the fixture DDL. */
export async function createEnvironment() {
  const adminUrl = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  if (
    !['postgres:', 'postgresql:'].includes(adminUrl.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname) ||
    adminUrl.pathname !== '/postgres' ||
    adminUrl.search
  ) {
    throw new Error('Authority tests require a localhost admin URL ending in /postgres');
  }
  const databaseName = `boardsesh_ba04_pr6_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const client = postgres(databaseUrl.toString(), { max: 2, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const database = drizzle(client, { schema });
  const close = async () => {
    await client.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    await admin.end({ timeout: 5 });
  };
  try {
    await client.unsafe(schemaSQL);
    const migration = readFileSync(
      new URL('../../../../../db/drizzle/0306_yielding_scrambler.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.unsafe(statement);
    }
    return {
      database,
      client,
      close,
      withAuthority: <T>(callback: (auth: ReturnType<typeof createAuthority>) => Promise<T>) =>
        database.transaction(async (transaction) => callback(createAuthority(transaction, configuration))),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
