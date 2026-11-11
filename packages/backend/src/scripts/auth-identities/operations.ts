import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { asc, gt } from 'drizzle-orm';
import { accounts, authAccount, authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema';
import type { AuthorityTransaction } from '../../auth/authority/adapter';
import { syncIdentity } from '../../auth/authority/sync-identity';
import { keyedDigest } from './private-state';

export function operatorTransaction(connection: postgres.TransactionSql, client: postgres.Sql): AuthorityTransaction {
  const transactionClient = new Proxy(connection, {
    get(target, property, receiver) {
      return property === 'options' ? client.options : Reflect.get(target, property, receiver);
    },
  });
  return drizzle(transactionClient as unknown as postgres.Sql) as unknown as AuthorityTransaction;
}

export async function importIdentityBatch(client: postgres.Sql, lastUserId: string | undefined, batch: number) {
  const database = drizzle(client);
  const selected = await database
    .select({ id: users.id })
    .from(users)
    .where(lastUserId === undefined ? undefined : gt(users.id, lastUserId))
    .orderBy(asc(users.id))
    .limit(batch);
  for (const user of selected) {
    await client.begin('isolation level read committed', async (connection) => {
      await syncIdentity(operatorTransaction(connection, client), user.id, 'current-store-to-authority');
    });
  }
  return { count: selected.length, lastUserId: selected.at(-1)?.id };
}

function indexByUser<Row extends { userId: string }>(rows: readonly Row[]): Map<string, Row[]> {
  const indexed = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = indexed.get(row.userId);
    if (existing) existing.push(row);
    else indexed.set(row.userId, [row]);
  }
  return indexed;
}

/** One stable read-only snapshot; identity content never escapes this function. */
export async function reconcileIdentities(client: postgres.Sql, key: Buffer) {
  return client.begin('isolation level repeatable read read only', async (connection) => {
    const transaction = operatorTransaction(connection, client);
    const source: string[] = [];
    const target: string[] = [];
    const selected = await transaction.select({ id: users.id }).from(users).orderBy(asc(users.id));
    // Five reads, regardless of account count. Never select OAuth token columns.
    const cutoffs = new Map((await transaction.select().from(authSubjectCutoffs)).map((row) => [row.userId, row]));
    const credentials = new Map((await transaction.select().from(userCredentials)).map((row) => [row.userId, row]));
    const providersByUser = indexByUser(
      await transaction
        .select({ userId: accounts.userId, provider: accounts.provider, providerAccountId: accounts.providerAccountId })
        .from(accounts),
    );
    const storedByUser = indexByUser(
      await transaction
        .select({
          userId: authAccount.userId,
          providerId: authAccount.providerId,
          accountId: authAccount.accountId,
          password: authAccount.password,
          sourceGeneration: authAccount.sourceGeneration,
        })
        .from(authAccount),
    );
    let missing = 0;
    let different = 0;
    let unexpected = 0;
    for (const user of selected) {
      const cutoff = cutoffs.get(user.id);
      const stored = storedByUser.get(user.id) ?? [];
      if (cutoff?.deletedAt) {
        unexpected += stored.length;
        for (const row of stored)
          target.push(keyedDigest(key, [user.id, row.providerId, row.accountId, row.password, row.sourceGeneration]));
        continue;
      }
      const generation = cutoff?.generation ?? 0;
      const credential = credentials.get(user.id);
      const providers = providersByUser.get(user.id) ?? [];
      const expected = [
        ...(credential
          ? [
              {
                providerId: 'credential',
                accountId: user.id,
                password: credential.passwordHash,
                sourceGeneration: generation,
              },
            ]
          : []),
        ...providers.map((provider) => ({
          providerId: provider.provider,
          accountId: provider.providerAccountId,
          password: null,
          sourceGeneration: generation,
        })),
      ];
      for (const row of expected) {
        source.push(keyedDigest(key, [user.id, row]));
        const matching = stored.find(
          (entry) => entry.providerId === row.providerId && entry.accountId === row.accountId,
        );
        if (!matching) missing++;
        else if (matching.password !== row.password || matching.sourceGeneration !== row.sourceGeneration) different++;
      }
      for (const row of stored) {
        target.push(
          keyedDigest(key, [
            user.id,
            {
              providerId: row.providerId,
              accountId: row.accountId,
              password: row.password,
              sourceGeneration: row.sourceGeneration,
            },
          ]),
        );
        if (!expected.some((entry) => entry.providerId === row.providerId && entry.accountId === row.accountId))
          unexpected++;
      }
    }
    return {
      users: selected.length,
      sourceRows: source.length,
      targetRows: target.length,
      missing,
      different,
      unexpected,
      sourceDigest: keyedDigest(key, source.sort()),
      targetDigest: keyedDigest(key, target.sort()),
    };
  });
}
