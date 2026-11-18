import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { closePool, createPool } from '@boardsesh/db/client';
import { isPrivateHostname } from '@boardsesh/db/client/config';
import { ACCOUNT_ID_PREFIX, SEED_OUTPUT_PREFIX, type SeededAccount } from './stack';

/**
 * The harness's database work, run with tsx by the global setup (Playwright's
 * own loader cannot load `@boardsesh/db`):
 *
 *   seed <account B id>   looks up the dev database's seeded test user (account A) and creates
 *                         account B beside it; prints both as JSON
 *   cleanup <account B id>  deletes account B, and by cascade everything it owns
 *
 * Account B goes in through the same two inserts the partner OAuth journey uses
 * (a `users` row and its `user_credentials` row), so the shared dev-database
 * image is never edited. A run killed outright never reaches its cleanup, so
 * `seed` first removes this suite's accounts left from runs over an hour ago.
 *
 * Refuses any database that is not on this machine or a private network.
 */

type SqlClient = ReturnType<typeof createPool>;

async function seedAccountA(sql: SqlClient, email: string, password: string): Promise<SeededAccount> {
  const [user] = await sql<{ id: string; name: string | null }[]>`
    SELECT id, name FROM users WHERE lower(email) = ${email.toLowerCase()} LIMIT 1
  `;
  if (!user) {
    throw new Error(
      `The dev database has no ${email} account. Recreate it: \`docker compose down -v && vp run db:up\` (e2e/SEED_CONTRACT.md).`,
    );
  }
  return { userId: user.id, email, password, name: user.name ?? 'Test User' };
}

async function seedAccountB(sql: SqlClient, userId: string): Promise<SeededAccount> {
  const account: SeededAccount = {
    userId,
    email: `${userId}@example.invalid`,
    password: randomBytes(18).toString('base64url'),
    name: 'Browser Session E2E Climber',
  };
  await sql`INSERT INTO users (id, email, name, "emailVerified") VALUES (${userId}, ${account.email}, ${account.name}, now())`;
  await sql`INSERT INTO user_credentials (user_id, password_hash) VALUES (${userId}, ${await hash(account.password, 10)})`;
  // Made ten minutes ago, not now: a sign-in within 60 s of a password write is
  // held back (partner-oauth-e2e/database.ts). Only updated_at moves.
  await sql`UPDATE user_credentials SET updated_at = now() - interval '10 minutes' WHERE user_id = ${userId}`;
  return account;
}

async function main(): Promise<void> {
  const [command, userId] = process.argv.slice(2);
  if (userId && !userId.startsWith(ACCOUNT_ID_PREFIX)) {
    throw new Error(`The browser-session e2e only touches accounts whose id starts with ${ACCOUNT_ID_PREFIX}.`);
  }
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const host = databaseUrl ? new URL(databaseUrl).hostname.toLowerCase() : '';
  if (!host || !isPrivateHostname(host)) {
    throw new Error(
      `Refusing to touch ${host || 'an unset DATABASE_URL'}: the browser-session e2e only runs on a local database.`,
    );
  }
  const sql = createPool();
  try {
    if (command === 'seed') {
      if (!userId) throw new Error('seed needs the id for account B.');
      await sql`
        DELETE FROM users
        WHERE id LIKE ${`${ACCOUNT_ID_PREFIX}%`} AND email LIKE ${`${ACCOUNT_ID_PREFIX}%@example.invalid`}
          AND created_at < now() - interval '1 hour'
      `;
      const accountA = await seedAccountA(
        sql,
        process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com',
        process.env.TEST_USER_PASSWORD ?? 'test',
      );
      const accountB = await seedAccountB(sql, userId);
      console.info(`${SEED_OUTPUT_PREFIX}${JSON.stringify({ accountA, accountB })}`);
    } else if (command === 'cleanup') {
      if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    } else {
      throw new Error(`Unknown command ${command ?? '(none)'}; use seed or cleanup.`);
    }
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
