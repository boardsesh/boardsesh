import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { accounts, users } from '@boardsesh/db/schema/auth';
import { getWorkerDatabaseUrl } from '../../../__tests__/worker-db';
import { schemaSQL } from '../../../__tests__/schema-sql';
import { hydrateAccountsFixtureSchema } from './fixtures/accounts-schema';

describe.sequential('canonical worker account fixture reuse', () => {
  let writer: postgres.Sql;

  beforeAll(() => {
    writer = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await writer?.end({ timeout: 5 });
  });

  it('clears prior provider rows and restores a validated user foreign key after two canonical resets', async () => {
    const fixtureSuffix = randomUUID();
    const database = drizzle(writer);
    await hydrateAccountsFixtureSchema(writer);

    for (const cycle of [1, 2]) {
      const ownerId = `audit-reset-${fixtureSuffix}-${cycle}`;
      const providerAccount = {
        userId: ownerId,
        provider: 'audit-reset-fixture',
        providerAccountId: ownerId,
        type: 'oauth',
      } satisfies typeof accounts.$inferInsert;
      await database.insert(users).values({ id: ownerId, email: `${ownerId}@example.test` });
      await database.insert(accounts).values(providerAccount);
      expect(
        await database.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.userId, ownerId)),
      ).toEqual([{ userId: ownerId }]);

      // Reapply exactly the canonical worker reset to this worker's current
      // disposable database. No retained namespace or separate DSN is used.
      await writer.unsafe(schemaSQL);
      await hydrateAccountsFixtureSchema(writer);

      expect(await database.select({ userId: accounts.userId }).from(accounts)).toEqual([]);
      expect(await database.select({ id: users.id }).from(users).where(eq(users.id, ownerId))).toEqual([]);
      const constraints = await writer<{ validated: boolean }[]>`
        SELECT convalidated AS validated
        FROM pg_catalog.pg_constraint
        WHERE conname = 'accounts_userId_users_id_fk'
          AND conrelid = 'public.accounts'::regclass
          AND confrelid = 'public.users'::regclass
          AND contype = 'f'
      `;
      expect(constraints).toHaveLength(1);
      expect(constraints[0]?.validated).toBe(true);
      await expect(database.insert(accounts).values(providerAccount)).rejects.toMatchObject({
        cause: { code: '23503' },
      });
      expect(await database.select({ userId: accounts.userId }).from(accounts)).toEqual([]);
    }
  });
});
