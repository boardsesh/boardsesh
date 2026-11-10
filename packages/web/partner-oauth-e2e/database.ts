import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { closePool, createPool } from '@boardsesh/db/client';
import { isPrivateHostname } from '@boardsesh/db/client/config';
import { SEED_OUTPUT_PREFIX, type SeededAccount, type SeedResult } from './stack';

/**
 * The journey's database work, run with tsx by the global setup (Playwright's
 * own loader cannot load `@boardsesh/db`):
 *
 *   seed            two accounts and one old tick; prints the result as JSON
 *   cleanup <ids>   deletes those accounts, and by cascade everything they own
 *
 * Refuses any database that is not on this machine or a private network.
 */

type SqlClient = ReturnType<typeof createPool>;

async function seedAccount(sql: SqlClient, role: 'developer' | 'climber'): Promise<SeededAccount> {
  const userId = `partner-e2e-${role}-${randomUUID()}`;
  const account: SeededAccount = {
    userId,
    email: `${userId}@example.invalid`,
    password: randomBytes(18).toString('base64url'),
    name: role === 'developer' ? 'Partner E2E Developer' : 'Partner E2E Climber',
  };
  await sql`INSERT INTO users (id, email, name, "emailVerified") VALUES (${userId}, ${account.email}, ${account.name}, now())`;
  await sql`INSERT INTO user_credentials (user_id, password_hash) VALUES (${userId}, ${await hash(account.password, 10)})`;
  // The account was made ten minutes ago, not now. A sign-in within 60 s of a
  // password write cannot approve an app (decision 19), so a brand-new account
  // would bounce back to sign-in for a minute. Only updated_at moves: the
  // revocation trigger watches password_hash and stays out of it.
  await sql`UPDATE user_credentials SET updated_at = now() - interval '10 minutes' WHERE user_id = ${userId}`;
  return account;
}

async function seed(sql: SqlClient): Promise<SeedResult> {
  const [climb] = await sql<{ uuid: string; name: string; layout_id: number }[]>`
    SELECT uuid, name, layout_id FROM board_climbs
    WHERE board_type = 'kilter' AND is_listed AND NOT is_draft AND name IS NOT NULL AND layout_id = 1
    ORDER BY uuid LIMIT 1
  `;
  if (!climb) {
    throw new Error(
      'The dev database has no listed Kilter climb. Recreate it: `docker compose down -v && vp run db:up`.',
    );
  }
  const developer = await seedAccount(sql, 'developer');
  const climber = await seedAccount(sql, 'climber');
  const historyTickId = randomUUID();
  await sql`
    INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, quality, comment, climbed_at)
    VALUES
      (${historyTickId}, ${climber.userId}, 'kilter', ${climb.uuid}, 40, false, 'send', 3, 4,
       'Logged long before the app existed', now() - interval '400 days')
  `;
  return {
    developer,
    climber,
    climb: { boardType: 'kilter', uuid: climb.uuid, name: climb.name, layoutId: climb.layout_id },
    historyTickId,
  };
}

async function main(): Promise<void> {
  const [command, ...userIds] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const host = databaseUrl ? new URL(databaseUrl).hostname.toLowerCase() : '';
  if (!host || !isPrivateHostname(host)) {
    throw new Error(
      `Refusing to touch ${host || 'an unset DATABASE_URL'}: the partner e2e only runs on a local database.`,
    );
  }
  const sql = createPool();
  try {
    if (command === 'seed') {
      console.info(`${SEED_OUTPUT_PREFIX}${JSON.stringify(await seed(sql))}`);
    } else if (command === 'cleanup') {
      const ids = userIds.filter((userId) => userId.startsWith('partner-e2e-'));
      // The users rows cascade into credentials, ticks, the app, its connection and every token.
      if (ids.length > 0) await sql`DELETE FROM users WHERE id IN ${sql(ids)}`;
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
