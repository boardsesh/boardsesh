import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { closePool, createPool } from '@boardsesh/db/client';
import { isPrivateHostname } from '@boardsesh/db/client/config';
import { ACCOUNT_ID_PREFIX, SEED_OUTPUT_PREFIX, type SeededAccount } from './stack';

/**
 * The harness's database work, run with tsx by the global setup and by specs
 * (Playwright's own loader cannot load `@boardsesh/db`):
 *
 *   seed <account B id>        looks up the dev database's seeded test user (account A) and creates
 *                              account B beside it; prints both as JSON
 *   create <id>                creates one more account for a single test; prints it as JSON
 *   cleanup <id or prefix%>    deletes this suite's accounts, and by cascade everything they own
 *   remove-password <id>       deletes an account's password row, as for a Google-only climber
 *   age-session <id> <session> <days>  sets the session row's expiry that many days ahead
 *   session-expiry <id> <session>      prints the session row's expiry, or null
 *
 * Accounts go in through the same two inserts the partner OAuth journey uses
 * (a `users` row and its `user_credentials` row), so the shared dev-database
 * image is never edited. A run killed outright never reaches its cleanup, so
 * `seed` first removes this suite's accounts left from runs over an hour ago.
 * Every command but `seed` touches only accounts whose id starts with
 * ACCOUNT_ID_PREFIX, and only on a database on this machine or a private network.
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

async function createAccount(sql: SqlClient, userId: string): Promise<SeededAccount> {
  const account: SeededAccount = {
    userId,
    email: `${userId}@example.invalid`,
    password: randomBytes(18).toString('base64url'),
    // Unique per account, so a spec can look for one climber's name on a page.
    name: `Climber ${userId.slice(-8)}`,
  };
  await sql`INSERT INTO users (id, email, name, "emailVerified") VALUES (${userId}, ${account.email}, ${account.name}, now())`;
  await sql`INSERT INTO user_credentials (user_id, password_hash) VALUES (${userId}, ${await hash(account.password, 10)})`;
  // Made ten minutes ago, not now: a sign-in within 60 s of a password write is
  // held back (partner-oauth-e2e/database.ts). Only updated_at moves.
  await sql`UPDATE user_credentials SET updated_at = now() - interval '10 minutes' WHERE user_id = ${userId}`;
  return account;
}

function print(result: unknown): void {
  console.info(`${SEED_OUTPUT_PREFIX}${JSON.stringify(result)}`);
}

async function run(sql: SqlClient, command: string | undefined, args: string[]): Promise<void> {
  const [userId, sessionId, days] = args;
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
    print({ accountA, accountB: await createAccount(sql, userId) });
  } else if (command === 'create') {
    print(await createAccount(sql, userId));
  } else if (command === 'cleanup') {
    // A trailing `%` deletes every account of one run; otherwise exactly one.
    if (userId?.endsWith('%')) await sql`DELETE FROM users WHERE id LIKE ${userId}`;
    else if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
  } else if (command === 'remove-password') {
    await sql`DELETE FROM user_credentials WHERE user_id = ${userId}`;
    print({ removed: true });
  } else if (command === 'age-session') {
    const daysAhead = Number(days);
    if (!sessionId || !Number.isFinite(daysAhead)) throw new Error('age-session needs a session id and a day count.');
    const aged = await sql`
      UPDATE auth_session SET expires_at = now() + make_interval(secs => ${daysAhead * 86_400})
      WHERE id = ${sessionId} AND user_id = ${userId}
      RETURNING id
    `;
    print({ aged: aged.length });
  } else if (command === 'session-expiry') {
    const [row] = await sql<{ expiresAt: Date }[]>`
      SELECT expires_at AS "expiresAt" FROM auth_session WHERE id = ${sessionId ?? ''} AND user_id = ${userId}
    `;
    print({ expiresAt: row?.expiresAt.toISOString() ?? null });
  } else {
    throw new Error(`Unknown command ${command ?? '(none)'}.`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const [userId] = args;
  if (userId && !userId.startsWith(ACCOUNT_ID_PREFIX)) {
    throw new Error(`The browser-session e2e only touches accounts whose id starts with ${ACCOUNT_ID_PREFIX}.`);
  }
  if (command !== 'seed' && !userId) throw new Error(`${command ?? 'A command'} needs an account id.`);
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const host = databaseUrl ? new URL(databaseUrl).hostname.toLowerCase() : '';
  if (!host || !isPrivateHostname(host)) {
    throw new Error(
      `Refusing to touch ${host || 'an unset DATABASE_URL'}: the browser-session e2e only runs on a local database.`,
    );
  }
  const sql = createPool();
  try {
    await run(sql, command, args);
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
