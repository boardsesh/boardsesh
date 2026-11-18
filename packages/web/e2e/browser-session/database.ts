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
 *   first-password <id>        makes an account one that may set a first password by email: no
 *                              password, a Google identity, a deliverable address (`@example.test`,
 *                              which the mailer accepts and the run's mail sink takes) and that
 *                              address's reservation, owned by the account under the current
 *                              projection; prints the new address
 *   has-password <id>          prints whether the account has a password row
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
    await sql.begin(async (transaction) => {
      const stale = await transaction<{ id: string }[]>`
        SELECT id FROM users
        WHERE id LIKE ${`${ACCOUNT_ID_PREFIX}%`}
          AND (email LIKE ${`${ACCOUNT_ID_PREFIX}%@example.invalid`} OR email LIKE ${`${ACCOUNT_ID_PREFIX}%@example.test`})
          AND created_at < now() - interval '1 hour'
      `;
      const ids = stale.map(({ id }) => id);
      if (ids.length === 0) return;
      await transaction`DELETE FROM auth_email_reservation_members WHERE user_id IN ${transaction(ids)}`;
      await transaction`DELETE FROM auth_email_reservations WHERE owner_user_id IN ${transaction(ids)}`;
      await transaction`DELETE FROM users WHERE id IN ${transaction(ids)}`;
    });
    const accountA = await seedAccountA(
      sql,
      process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com',
      process.env.TEST_USER_PASSWORD ?? 'test',
    );
    print({ accountA, accountB: await createAccount(sql, userId) });
  } else if (command === 'create') {
    print(await createAccount(sql, userId));
  } else if (command === 'cleanup') {
    // A trailing `%` deletes every account of one run; otherwise exactly one. Reservations
    // (first-password) have no foreign key to users, so they go first, members before the row.
    const pattern = userId ?? '';
    await sql`DELETE FROM auth_email_reservation_members WHERE user_id LIKE ${pattern}`;
    await sql`DELETE FROM auth_email_reservations WHERE owner_user_id LIKE ${pattern}`;
    await sql`DELETE FROM users WHERE id LIKE ${pattern}`;
  } else if (command === 'first-password') {
    // The same rows the backend's first-password proof makes (first-password-http.proof.ts).
    const email = `${userId}@example.test`.toLowerCase();
    const [projection] = await sql<{ projectionId: string }[]>`
      SELECT projection_id AS "projectionId" FROM auth_email_projection WHERE is_current
    `;
    if (!projection) throw new Error('No current email projection: the better-auth database step has not run.');
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM user_credentials WHERE user_id = ${userId}`;
      await transaction`UPDATE users SET email = ${email} WHERE id = ${userId}`;
      await transaction`
        INSERT INTO accounts ("userId", type, provider, "providerAccountId")
        VALUES (${userId}, 'oauth', 'google', ${`google-${randomBytes(12).toString('hex')}`})
      `;
      await transaction`
        INSERT INTO auth_email_reservations (normalized_email, basis_projection_id, state, owner_user_id)
        VALUES (${email}, ${projection.projectionId}, 'owned', ${userId})
      `;
      await transaction`INSERT INTO auth_email_reservation_members (normalized_email, user_id) VALUES (${email}, ${userId})`;
    });
    print({ email });
  } else if (command === 'remove-password') {
    await sql`DELETE FROM user_credentials WHERE user_id = ${userId}`;
    print({ removed: true });
  } else if (command === 'has-password') {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_credentials WHERE user_id = ${userId}
    `;
    print({ hasPassword: (row?.count ?? 0) > 0 });
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
    // The column has no time zone and holds UTC; render it as an ISO instant in SQL.
    const [row] = await sql<{ expiresAt: string }[]>`
      SELECT to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
      FROM auth_session WHERE id = ${sessionId ?? ''} AND user_id = ${userId}
    `;
    print({ expiresAt: row?.expiresAt ?? null });
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
