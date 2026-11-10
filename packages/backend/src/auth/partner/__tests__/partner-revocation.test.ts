import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  accounts,
  mobileRefreshTokens,
  oauthAccessToken,
  oauthClient,
  oauthConnections,
  oauthSubjects,
  sessions,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { getWorkerDatabaseUrl } from '../../../__tests__/worker-db';
import { insertCurrentStorePasswordIdentity } from '../../current-store/password-identity';
import {
  attachPartnerState,
  countsOf,
  createApp,
  createUser,
  INTACT_COUNTS,
  PARTNER_PROBE_TABLES,
  PASSWORD_HASH,
  passwordHashOf,
  readPartnerState,
  REVOKED_COUNTS,
  seedConnectedClimber,
  type PartnerRows,
} from './revocation-fixtures';

/**
 * The *_partner_revocation_trigger.sql migration. Each row of the revocation table
 * has a test, and they do not all prove the same thing:
 *
 * - Rows 2 and 5 run the real backend code (in current-store/__tests__), and row 9
 *   runs the real identity insert.
 * - Rows 1 and 3 replay the statements of the named web route, in order, because
 *   Next routes cannot be imported here. A change to the route itself goes unseen.
 * - Rows 4 and 16 issue the same UPDATE a writer would. Row 4 has no writer today.
 * - Row 6 deletes the users row the adapter would delete. Row 15 calls the function.
 * - Rows 7, 8 and 10-14 issue the table write that path makes, or could make. No
 *   handler runs. They fail if a hook on that table starts ending connections, and
 *   say nothing about what the handler does.
 */

type RawSql = ReturnType<typeof postgres>;
interface DatabaseSession {
  sql: postgres.ReservedSql;
  pid: number;
}

const NEW_HASH = 'fixture-password-hash-after';
const RACE_TIMEOUT_MS = 30_000;
const LOCK_WAIT_DEADLINE_MS = 15_000;
const SETTLE_DEADLINE_MS = 12_000;
const DEFAULT_LOCK_BUDGET = '5s';
const SHORT_LOCK_BUDGET = '200ms';
const UNBLOCKED_WRITE_MS = 3_000;
const STATEMENT_TIMEOUT = '300ms';
const GUARD_ATTEMPT_ALLOWANCE_MS = 6_000;
const DRIZZLE_DIRECTORY = new URL('../../../../../db/drizzle/', import.meta.url);

let pool: RawSql;
const openSessions = new Set<DatabaseSession>();

beforeAll(() => {
  pool = postgres(getWorkerDatabaseUrl(), { max: 8, onnotice: () => {} });
});

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

afterEach(async () => {
  // Together, not in turn: a session parked behind another's lock would otherwise
  // hold its own queued ROLLBACK until the one ahead of it released that lock.
  await Promise.allSettled([...openSessions].map((session) => session.sql`ROLLBACK`.execute()));
  for (const session of openSessions) session.sql.release();
  openSessions.clear();
});

async function openSession(): Promise<DatabaseSession> {
  const reserved = await pool.reserve();
  const [row] = await reserved`SELECT pg_backend_pid() AS pid`;
  const session = { sql: reserved, pid: Number(row.pid) };
  openSessions.add(session);
  return session;
}

/** Waits until the backend is parked on a heavyweight lock, so a race is really a race. */
async function waitUntilBlocked(pid: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
  while (Date.now() < deadline) {
    const [row] = await pool`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (row?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${pid} never waited on a lock`);
}

/** A deadlock that resolves the wrong way must fail the test, not hang it. */
async function withinDeadline<Result>(operation: Promise<Result>, label: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), SETTLE_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function postgresCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : postgresCode(candidate.cause);
}

function migrationStatements(): string[] {
  const migration = readdirSync(DRIZZLE_DIRECTORY).find((name) => name.endsWith('_partner_revocation_trigger.sql'));
  if (!migration) throw new Error('The partner revocation migration is missing');
  return readFileSync(new URL(migration, DRIZZLE_DIRECTORY), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim());
}

async function setLockBudget(budget: string): Promise<void> {
  await pool.unsafe(`ALTER FUNCTION public.partner_revoke_user(text) SET lock_timeout = '${budget}'`);
}

async function expectRevoked(rows: PartnerRows): Promise<void> {
  const state = await readPartnerState(rows);
  expect(countsOf(state)).toEqual(REVOKED_COUNTS);
  expect(state.connection.generation).toBe(1);
  expect(state.connection.revokedAt).not.toBeNull();
  expect(state.connection.revocationReason).toBe('account_security_revocation');
}

async function expectIntact(rows: PartnerRows): Promise<void> {
  const state = await readPartnerState(rows);
  expect(countsOf(state)).toEqual(INTACT_COUNTS);
  expect(state.connection.generation).toBe(0);
  expect(state.connection.revokedAt).toBeNull();
}

describe('every path in the partner revocation table', () => {
  it('row 1: legacy forgotten-password reset ends connections (route update branch)', async () => {
    const rows = await seedConnectedClimber();
    // Statement for statement: web/app/api/auth/reset-password/route.ts transaction.
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ userId: userCredentials.userId })
        .from(userCredentials)
        .where(eq(userCredentials.userId, rows.climberId))
        .limit(1);
      expect(existing).toHaveLength(1);
      await tx
        .update(userCredentials)
        .set({ passwordHash: NEW_HASH, updatedAt: new Date() })
        .where(eq(userCredentials.userId, rows.climberId));
      await tx
        .update(users)
        .set({ emailVerified: new Date(), updatedAt: new Date() })
        .where(and(eq(users.id, rows.climberId), isNull(users.emailVerified)));
      await tx.delete(verificationTokens).where(eq(verificationTokens.identifier, `password-reset:${rows.climberId}`));
    });
    expect(await passwordHashOf(rows.climberId)).toBe(NEW_HASH);
    await expectRevoked(rows);
  });

  it('row 1: legacy reset ends connections on the route insert branch too (OAuth-only account)', async () => {
    const climberId = await createUser('oauth-only');
    const rows = await attachPartnerState(climberId, await createApp(await createUser('developer')));
    await db.transaction(async (tx) => {
      await tx.insert(userCredentials).values({ userId: climberId, passwordHash: NEW_HASH });
    });
    expect(await passwordHashOf(climberId)).toBe(NEW_HASH);
    await expectRevoked(rows);
  });

  // Row 2 (staged reset) runs through consumePasswordRecovery in current-store/__tests__/password-recovery.test.ts.

  it('row 3: set-password on an OAuth-only account ends connections (web internal route)', async () => {
    const climberId = await createUser('oauth-only');
    const rows = await attachPartnerState(climberId, await createApp(await createUser('developer')));
    // Statement for statement: web/app/api/internal/set-password/route.ts transaction.
    await db.transaction(async (tx) => {
      await tx.insert(userCredentials).values({ userId: climberId, passwordHash: NEW_HASH });
      await tx
        .update(users)
        .set({ emailVerified: new Date(), updatedAt: new Date() })
        .where(and(eq(users.id, climberId), isNull(users.emailVerified)));
    });
    await expectRevoked(rows);
  });

  it('row 4: a change-password writer ends connections through the same UPDATE', async () => {
    const rows = await seedConnectedClimber();
    await db.update(userCredentials).set({ passwordHash: NEW_HASH }).where(eq(userCredentials.userId, rows.climberId));
    await expectRevoked(rows);
  });

  // Row 5 (account deletion, legacy and staged) runs through the real resolver in
  // current-store/__tests__/account-deletion.test.ts.

  it('row 6: a direct users delete, as the NextAuth adapter would issue, cascades everything', async () => {
    const rows = await seedConnectedClimber();
    await db.delete(users).where(eq(users.id, rows.climberId));
    expect(countsOf(await readPartnerState(rows))).toEqual({
      connections: 0,
      subjects: 0,
      sessions: 0,
      grants: 0,
      pendingCodes: 1, // The code row has no user column; the session it names is gone.
      refreshTokens: 0,
      accessTokens: 0,
      consents: 0,
      ancestors: 0,
      interactions: 0,
    });
    expect(await db.$count(oauthClient, eq(oauthClient.clientId, rows.clientId))).toBe(1);
  });

  it('row 7: provider unlink ends no connection today', async () => {
    const rows = await seedConnectedClimber();
    await db
      .insert(accounts)
      .values({ userId: rows.climberId, provider: 'google', providerAccountId: randomUUID(), type: 'oauth' });
    await db.delete(accounts).where(eq(accounts.userId, rows.climberId));
    await expectIntact(rows);
  });

  it('row 8: provider link ends no connection', async () => {
    const rows = await seedConnectedClimber();
    await db
      .insert(accounts)
      .values({ userId: rows.climberId, provider: 'apple', providerAccountId: randomUUID(), type: 'oauth' });
    await expectIntact(rows);
  });

  it('row 9: registration commits through the real identity insert and the trigger fires', async () => {
    const email = `${randomUUID()}@example.invalid`;
    const created = await db.transaction((tx) =>
      insertCurrentStorePasswordIdentity(tx, { email, name: 'New climber', passwordHash: NEW_HASH }, true),
    );
    expect(await passwordHashOf(created.userId)).toBe(NEW_HASH);

    // A connection cannot exist before its user, so prove the INSERT path fires by
    // creating the connection inside the registering transaction.
    const developerId = await createUser('developer');
    const clientId = await createApp(developerId);
    const climberId = `registered-${randomUUID()}`;
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: climberId, email: `${climberId}@example.invalid` });
      await tx.insert(oauthConnections).values({ id: randomUUID(), userId: climberId, clientId });
      await tx.insert(userCredentials).values({ userId: climberId, passwordHash: NEW_HASH });
    });
    const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.userId, climberId));
    expect(connection.generation).toBe(1);
    expect(connection.revokedAt).not.toBeNull();
  });

  it('row 10: web sign-out writes no row and the JWT stays valid; a sessions delete ends no connection', async () => {
    const rows = await seedConnectedClimber();
    // Sign-out only clears the cookie. Deleting a sessions row is the closest database
    // write, and all this proves is that the write does not end a partner connection.
    await db
      .insert(sessions)
      .values({ userId: rows.climberId, sessionToken: randomUUID(), expires: new Date(Date.now() + 60_000) });
    await db.delete(sessions).where(eq(sessions.userId, rows.climberId));
    await expectIntact(rows);
  });

  it('row 11: native sign-out and refresh cleanup end no connection', async () => {
    const rows = await seedConnectedClimber();
    await db.insert(mobileRefreshTokens).values({
      userId: rows.climberId,
      tokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(mobileRefreshTokens.userId, rows.climberId));
    await expectIntact(rows);
  });

  it('row 12: watch pairing issues a refresh token and ends no connection', async () => {
    const rows = await seedConnectedClimber();
    await db.insert(mobileRefreshTokens).values({
      userId: rows.climberId,
      tokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expectIntact(rows);
  });

  it('row 13: an emailVerified write ends no connection', async () => {
    const rows = await seedConnectedClimber();
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, rows.climberId));
    await expectIntact(rows);
  });

  it('row 14: an email change ends no connection', async () => {
    const rows = await seedConnectedClimber();
    await db
      .update(users)
      .set({ email: `changed-${randomUUID()}@example.invalid` })
      .where(eq(users.id, rows.climberId));
    await expectIntact(rows);
  });

  it('row 15: admin account-wide revocation calls partner_revoke_user directly', async () => {
    const rows = await seedConnectedClimber();
    const [result] = await pool`SELECT public.partner_revoke_user(${rows.climberId}) AS revoked`;
    expect(result.revoked).toBe(1);
    await expectRevoked(rows);
    expect(await passwordHashOf(rows.climberId)).toBe(PASSWORD_HASH);
  });

  it('row 16: direct SQL fires the trigger; only replica role and TRUNCATE bypass it', async () => {
    const rows = await seedConnectedClimber();
    await pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`;
    await expectRevoked(rows);

    const replicaBypass = await seedConnectedClimber();
    const replicaSession = await openSession();
    await replicaSession.sql`SET session_replication_role = replica`;
    await replicaSession.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${replicaBypass.climberId}`;
    await replicaSession.sql`SET session_replication_role = DEFAULT`;
    await expectIntact(replicaBypass);

    const truncated = await seedConnectedClimber();
    const truncateSession = await openSession();
    await truncateSession.sql`BEGIN`;
    await truncateSession.sql`TRUNCATE user_credentials`;
    const [connection] =
      await truncateSession.sql`SELECT revoked_at FROM oauth_connections WHERE id = ${truncated.connectionId}`;
    expect(connection.revoked_at).toBeNull();
    await truncateSession.sql`ROLLBACK`;
  });
});

describe('partner_revoke_user effects', () => {
  it('revokes every connection the climber has across apps, and nobody else', async () => {
    const developerId = await createUser('developer');
    const firstApp = await createApp(developerId);
    const secondApp = await createApp(developerId);
    const climberId = await createUser('climber');
    await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
    const first = await attachPartnerState(climberId, firstApp);
    const second = await attachPartnerState(climberId, secondApp);
    const bystander = await seedConnectedClimber('bystander');

    await db.update(userCredentials).set({ passwordHash: NEW_HASH }).where(eq(userCredentials.userId, climberId));

    await expectRevoked(first);
    const secondState = await readPartnerState(second);
    expect(secondState.connection.generation).toBe(1);
    expect(secondState.connection.revokedAt).not.toBeNull();
    await expectIntact(bystander);
  });

  it('leaves a developer who is also a climber their app, its policy and other climbers', async () => {
    const rows = await seedConnectedClimber();
    const [app] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, rows.clientId));
    await db.insert(userCredentials).values({ userId: app.userId!, passwordHash: PASSWORD_HASH });

    await db.update(userCredentials).set({ passwordHash: NEW_HASH }).where(eq(userCredentials.userId, app.userId!));

    expect(await db.$count(oauthClient, eq(oauthClient.clientId, rows.clientId))).toBe(1);
    await expectIntact(rows);
  });

  it('bumps the generation on an already revoked connection and keeps its reason and time', async () => {
    const rows = await seedConnectedClimber();
    const revokedAt = new Date('2026-01-01T00:00:00.000Z');
    await db
      .update(oauthConnections)
      .set({ revokedAt, revocationReason: 'disconnect', generation: 3 })
      .where(eq(oauthConnections.id, rows.connectionId));

    await db.update(userCredentials).set({ passwordHash: NEW_HASH }).where(eq(userCredentials.userId, rows.climberId));

    const state = await readPartnerState(rows);
    expect(state.connection.generation).toBe(4);
    expect(state.connection.revokedAt).toEqual(revokedAt);
    expect(state.connection.revocationReason).toBe('disconnect');
  });

  it('does nothing when the hash is rewritten unchanged, or only updated_at moves', async () => {
    const rows = await seedConnectedClimber();
    await db
      .update(userCredentials)
      .set({ passwordHash: PASSWORD_HASH })
      .where(eq(userCredentials.userId, rows.climberId));
    await db
      .update(userCredentials)
      .set({ updatedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(userCredentials.userId, rows.climberId));
    await expectIntact(rows);
    const [stored] = await db
      .select({ updatedAt: userCredentials.updatedAt })
      .from(userCredentials)
      .where(eq(userCredentials.userId, rows.climberId));
    expect(stored.updatedAt).toEqual(new Date('2020-01-01T00:00:00Z'));
  });

  it('sets updated_at from the database clock as UTC when the hash changes, whatever the session TimeZone', async () => {
    const rows = await seedConnectedClimber();
    const session = await openSession();
    await session.sql`SET TIME ZONE 'Pacific/Auckland'`;
    await session.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH}, updated_at = '2001-01-01' WHERE user_id = ${rows.climberId}`;
    const [stored] = await db
      .select({ updatedAt: userCredentials.updatedAt })
      .from(userCredentials)
      .where(eq(userCredentials.userId, rows.climberId));
    // Drizzle reads the naive column as UTC; a local-time write would be 12+ hours off.
    expect(Math.abs(stored.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('keeps a caller-supplied updated_at on insert, so a data-only reload stays faithful', async () => {
    const climberId = await createUser('reloaded');
    const original = new Date('2024-05-05T05:05:05.000Z');
    await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH, updatedAt: original });
    const [stored] = await db
      .select({ updatedAt: userCredentials.updatedAt })
      .from(userCredentials)
      .where(eq(userCredentials.userId, climberId));
    expect(stored.updatedAt).toEqual(original);
  });

  it('treats ON CONFLICT DO NOTHING as no change, and DO UPDATE as a hash change', async () => {
    const rows = await seedConnectedClimber();
    await db.insert(userCredentials).values({ userId: rows.climberId, passwordHash: NEW_HASH }).onConflictDoNothing();
    await expectIntact(rows);
    expect(await passwordHashOf(rows.climberId)).toBe(PASSWORD_HASH);

    await db
      .insert(userCredentials)
      .values({ userId: rows.climberId, passwordHash: NEW_HASH })
      .onConflictDoUpdate({ target: userCredentials.userId, set: { passwordHash: NEW_HASH } });
    await expectRevoked(rows);
  });

  it('is a no-op for an unknown user and leaves the foreign key to reject the write', async () => {
    const [result] = await pool`SELECT public.partner_revoke_user(${`missing-${randomUUID()}`}) AS revoked`;
    expect(result.revoked).toBe(0);
    await expect(
      pool`INSERT INTO user_credentials (user_id, password_hash) VALUES (${`missing-${randomUUID()}`}, 'hash')`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('returns NULL for a NULL user id without touching anything', async () => {
    const [result] = await pool`SELECT public.partner_revoke_user(NULL) AS revoked`;
    expect(result.revoked).toBeNull();
  });

  it('keeps the stable subject row for a future reconnect', async () => {
    const rows = await seedConnectedClimber();
    await db.update(userCredentials).set({ passwordHash: NEW_HASH }).where(eq(userCredentials.userId, rows.climberId));
    expect(await db.$count(oauthSubjects, eq(oauthSubjects.userId, rows.climberId))).toBe(1);
  });
});

describe('lock order', () => {
  it(
    'waits for an in-flight issuer, then removes the token it just committed (READ COMMITTED re-read)',
    async () => {
      const rows = await seedConnectedClimber();
      const issuer = await openSession();
      const writer = await openSession();
      const issuedTokenId = randomUUID();

      await issuer.sql`BEGIN`;
      await issuer.sql`SELECT id FROM users WHERE id = ${rows.climberId} FOR SHARE`;
      await issuer.sql`
        INSERT INTO oauth_access_token (id, token, client_id, user_id, expires_at, created_at, scopes)
        VALUES (${issuedTokenId}, ${`issued-${issuedTokenId}`}, ${rows.clientId}, ${rows.climberId},
                now() + interval '1 hour', now(), ARRAY['offline_access'])`;

      await writer.sql`BEGIN`;
      const write =
        writer.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`.execute();
      await waitUntilBlocked(writer.pid);

      await issuer.sql`COMMIT`;
      await write;
      await writer.sql`COMMIT`;

      expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, issuedTokenId))).toBe(0);
      await expectRevoked(rows);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'holds a later issuer behind the password write, and that issuer then sees the revocation',
    async () => {
      const rows = await seedConnectedClimber();
      const writer = await openSession();
      const issuer = await openSession();

      await writer.sql`BEGIN`;
      await writer.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`;

      await issuer.sql`BEGIN`;
      const issuerLock = issuer.sql`SELECT id FROM users WHERE id = ${rows.climberId} FOR SHARE`.execute();
      await waitUntilBlocked(issuer.pid);

      await writer.sql`COMMIT`;
      await issuerLock;
      const [connection] =
        await issuer.sql`SELECT revoked_at, generation FROM oauth_connections WHERE id = ${rows.connectionId}`;
      await issuer.sql`COMMIT`;

      expect(connection.revoked_at).not.toBeNull();
      expect(connection.generation).toBe(1);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'still makes account deletion wait for an in-flight issuer',
    async () => {
      const rows = await seedConnectedClimber();
      const issuer = await openSession();
      const deleter = await openSession();

      await issuer.sql`BEGIN`;
      await issuer.sql`SELECT id FROM users WHERE id = ${rows.climberId} FOR SHARE`;

      await deleter.sql`BEGIN`;
      const deletion = deleter.sql`DELETE FROM users WHERE id = ${rows.climberId}`.execute();
      await waitUntilBlocked(deleter.pid);

      await issuer.sql`COMMIT`;
      await withinDeadline(deletion, 'account deletion');
      await deleter.sql`COMMIT`;
      expect(await db.$count(users, eq(users.id, rows.climberId))).toBe(0);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'does not wait for a foreign-key insert held open, so a sync page cannot delay a reset',
    async () => {
      const rows = await seedConnectedClimber();
      const syncPage = await openSession();
      await syncPage.sql`BEGIN`;
      await syncPage.sql`
        INSERT INTO mobile_refresh_tokens (id, user_id, token_hash, expires_at)
        VALUES (${randomUUID()}, ${rows.climberId}, ${randomBytes(32).toString('hex')}, now() + interval '1 hour')`;

      const startedAt = performance.now();
      await withinDeadline(
        pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`,
        'password write',
      );

      expect(performance.now() - startedAt).toBeLessThan(UNBLOCKED_WRITE_MS);
      await syncPage.sql`COMMIT`;
      await expectRevoked(rows);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'does not hold a foreign-key insert behind a password write in progress',
    async () => {
      const rows = await seedConnectedClimber();
      const writer = await openSession();
      await writer.sql`BEGIN`;
      await writer.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`;

      const startedAt = performance.now();
      await withinDeadline(
        pool`
          INSERT INTO mobile_refresh_tokens (id, user_id, token_hash, expires_at)
          VALUES (${randomUUID()}, ${rows.climberId}, ${randomBytes(32).toString('hex')}, now() + interval '1 hour')`,
        'foreign-key insert',
      );

      expect(performance.now() - startedAt).toBeLessThan(UNBLOCKED_WRITE_MS);
      await writer.sql`COMMIT`;
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'takes the users lock re-entrantly in the staged reset order (users, then the hash)',
    async () => {
      const rows = await seedConnectedClimber();
      const writer = await openSession();
      await writer.sql`BEGIN`;
      await writer.sql`SELECT id FROM users WHERE id = ${rows.climberId} FOR UPDATE`;
      await writer.sql`SELECT user_id FROM user_credentials WHERE user_id = ${rows.climberId} FOR UPDATE`;
      await writer.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`;
      await writer.sql`COMMIT`;
      await expectRevoked(rows);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'serializes two resets of the same climber without a deadlock',
    async () => {
      const rows = await seedConnectedClimber();
      const first = await openSession();
      const second = await openSession();
      await first.sql`BEGIN`;
      await first.sql`UPDATE user_credentials SET password_hash = 'first-hash' WHERE user_id = ${rows.climberId}`;
      await second.sql`BEGIN`;
      const secondWrite =
        second.sql`UPDATE user_credentials SET password_hash = 'second-hash' WHERE user_id = ${rows.climberId}`.execute();
      await waitUntilBlocked(second.pid);
      await first.sql`COMMIT`;
      await secondWrite;
      await second.sql`COMMIT`;
      expect(await passwordHashOf(rows.climberId)).toBe('second-hash');
      const state = await readPartnerState(rows);
      expect(countsOf(state)).toEqual(REVOKED_COUNTS);
      // The first reset ended everything, so the second has nothing left to end.
      expect(state.connection.generation).toBe(1);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'does not deadlock account deletion against an INSERT of a first password',
    async () => {
      const climberId = await createUser('oauth-only');
      await attachPartnerState(climberId, await createApp(await createUser('developer')));
      const inserter = await openSession();
      const deleter = await openSession();

      await deleter.sql`BEGIN`;
      await deleter.sql`SELECT id FROM users WHERE id = ${climberId} FOR UPDATE`;

      await inserter.sql`BEGIN`;
      // Settle the insert at once: it rejects as soon as the deleter commits, which can be
      // before this test reaches its expectation, and an unobserved rejection fails the run.
      const insertOutcome =
        inserter.sql`INSERT INTO user_credentials (user_id, password_hash) VALUES (${climberId}, ${NEW_HASH})`
          .execute()
          .then(
            () => ({ status: 'fulfilled' as const }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          );
      await waitUntilBlocked(inserter.pid);

      await deleter.sql`DELETE FROM users WHERE id = ${climberId}`;
      await deleter.sql`COMMIT`;
      // The user is gone, so the insert's foreign key rejects it: a clean failure, not a deadlock.
      const outcome = await withinDeadline(insertOutcome, 'first-password insert after deletion');
      expect(outcome).toMatchObject({ status: 'rejected', reason: { code: '23503' } });
      await inserter.sql`ROLLBACK`;
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'resolves the reset/deletion cycle with one 40P01, leaving a consistent account either way',
    async () => {
      const rows = await seedConnectedClimber();
      const deleter = await openSession();
      const resetter = await openSession();

      await deleter.sql`BEGIN`;
      await deleter.sql`SELECT id FROM users WHERE id = ${rows.climberId} FOR UPDATE`;

      await resetter.sql`BEGIN`;
      // The executor locks the credentials row, then the trigger queues on users.
      const reset =
        resetter.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`.execute();
      await waitUntilBlocked(resetter.pid);

      // Deletion holds users and now needs the credentials row in its cascade.
      const deletion = deleter.sql`DELETE FROM users WHERE id = ${rows.climberId}`.execute();

      const [resetOutcome, deletionOutcome] = await withinDeadline(
        Promise.allSettled([reset, deletion]),
        'reset/deletion cycle',
      );
      const outcomes = [resetOutcome, deletionOutcome];
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const failure = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(postgresCode(failure.reason)).toBe('40P01');

      if (resetOutcome.status === 'fulfilled') {
        await resetter.sql`COMMIT`;
        await deleter.sql`ROLLBACK`;
        expect(await passwordHashOf(rows.climberId)).toBe(NEW_HASH);
        await expectRevoked(rows);
      } else {
        await resetter.sql`ROLLBACK`;
        await deleter.sql`COMMIT`;
        expect(await db.$count(users, eq(users.id, rows.climberId))).toBe(0);
        expect(await db.$count(oauthConnections, eq(oauthConnections.id, rows.connectionId))).toBe(0);
      }
    },
    RACE_TIMEOUT_MS,
  );
});

describe('failure policy', () => {
  afterEach(async () => {
    await setLockBudget(DEFAULT_LOCK_BUDGET);
  });

  it('with no partner rows, a password write succeeds and touches nothing partner', async () => {
    const climberId = await createUser('nobody-connected');
    await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
    await db.update(userCredentials).set({ passwordHash: NEW_HASH }).where(eq(userCredentials.userId, climberId));
    expect(await passwordHashOf(climberId)).toBe(NEW_HASH);
  });

  it(
    'with no partner rows, a lock held past the budget does not stop the password write',
    async () => {
      await setLockBudget(SHORT_LOCK_BUDGET);
      const climberId = await createUser('nobody-connected');
      await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
      const holder = await openSession();
      await holder.sql`BEGIN`;
      await holder.sql`SELECT id FROM users WHERE id = ${climberId} FOR SHARE`;

      await pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${climberId}`;

      expect(await passwordHashOf(climberId)).toBe(NEW_HASH);
      await holder.sql`ROLLBACK`;
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'with partner rows, a lock held past the budget fails the write as 55P03 and changes nothing',
    async () => {
      await setLockBudget(SHORT_LOCK_BUDGET);
      const rows = await seedConnectedClimber();
      const holder = await openSession();
      await holder.sql`BEGIN`;
      await holder.sql`SELECT id FROM users WHERE id = ${rows.climberId} FOR SHARE`;

      await expect(
        pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`,
      ).rejects.toMatchObject({ code: '55P03' });

      expect(await passwordHashOf(rows.climberId)).toBe(PASSWORD_HASH);
      await expectIntact(rows);
      await holder.sql`ROLLBACK`;
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'with no partner rows, a deadlock with deletion still commits the password write',
    async () => {
      const climberId = await createUser('nobody-connected');
      await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
      const deleter = await openSession();
      const resetter = await openSession();

      await deleter.sql`BEGIN`;
      await deleter.sql`SELECT id FROM users WHERE id = ${climberId} FOR UPDATE`;
      await resetter.sql`BEGIN`;
      const reset =
        resetter.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${climberId}`.execute();
      await waitUntilBlocked(resetter.pid);
      const deletion = deleter.sql`DELETE FROM users WHERE id = ${climberId}`.execute();
      const deletionSettled = deletion.then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );

      // The password write never fails. If the reset is the deadlock victim it gives
      // up the users lock and carries on, and deletion stays parked on the credentials
      // row until this COMMIT. If deletion is the victim, the reset simply proceeds.
      await withinDeadline(reset, 'password write');
      await resetter.sql`COMMIT`;
      const deletionOutcome = await withinDeadline(deletionSettled, 'account deletion');
      if (deletionOutcome.status === 'fulfilled') {
        await deleter.sql`COMMIT`;
        expect(await passwordHashOf(climberId)).toBeUndefined();
      } else {
        expect(postgresCode(deletionOutcome.reason)).toBe('40P01');
        await deleter.sql`ROLLBACK`;
        expect(await passwordHashOf(climberId)).toBe(NEW_HASH);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'with no partner rows, fails the write as 57014 when statement_timeout fires during the lock wait',
    async () => {
      const climberId = await createUser('nobody-connected');
      await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
      const holder = await openSession();
      await holder.sql`BEGIN`;
      await holder.sql`SELECT id FROM users WHERE id = ${climberId} FOR SHARE`;
      const writer = await openSession();
      await writer.sql`BEGIN`;
      await writer.sql.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

      await expect(
        writer.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${climberId}`,
      ).rejects.toMatchObject({ code: '57014' });

      await writer.sql`ROLLBACK`;
      expect(await passwordHashOf(climberId)).toBe(PASSWORD_HASH);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'with no partner rows, writes no partner table, so a lock blocking writes there cannot stop the password',
    async () => {
      await setLockBudget(SHORT_LOCK_BUDGET);
      const climberId = await createUser('nobody-connected');
      await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
      const holder = await openSession();
      await holder.sql`BEGIN`;
      // SHARE conflicts with the ROW EXCLUSIVE a DELETE needs, not the ACCESS SHARE a probe needs.
      await holder.sql`LOCK TABLE oauth_session IN SHARE MODE`;

      await pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${climberId}`;

      expect(await passwordHashOf(climberId)).toBe(NEW_HASH);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'fails the write as 55P03 when ACCESS EXCLUSIVE on a partner table outlasts the budget',
    async () => {
      await setLockBudget(SHORT_LOCK_BUDGET);
      const climberId = await createUser('nobody-connected');
      await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
      const holder = await openSession();
      await holder.sql`BEGIN`;
      await holder.sql`LOCK TABLE oauth_session IN ACCESS EXCLUSIVE MODE`;

      await expect(
        pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${climberId}`,
      ).rejects.toMatchObject({ code: '55P03' });

      await holder.sql`ROLLBACK`;
      expect(await passwordHashOf(climberId)).toBe(PASSWORD_HASH);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'lets a contended write through when the only connection was revoked long ago, and leaves it alone',
    async () => {
      await setLockBudget(SHORT_LOCK_BUDGET);
      const climberId = await createUser('disconnected-long-ago');
      await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
      const clientId = await createApp(await createUser('developer'));
      const connectionId = randomUUID();
      const revokedAt = new Date('2025-01-01T00:00:00.000Z');
      await db.insert(oauthConnections).values({
        id: connectionId,
        userId: climberId,
        clientId,
        revokedAt,
        revocationReason: 'disconnect',
        generation: 2,
      });
      const holder = await openSession();
      await holder.sql`BEGIN`;
      await holder.sql`SELECT id FROM users WHERE id = ${climberId} FOR SHARE`;

      await pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${climberId}`;

      expect(await passwordHashOf(climberId)).toBe(NEW_HASH);
      const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.id, connectionId));
      expect(connection.generation).toBe(2);
      expect(connection.revokedAt).toEqual(revokedAt);
    },
    RACE_TIMEOUT_MS,
  );

  describe.each(PARTNER_PROBE_TABLES)('a climber whose only partner row is in $table', (probeTable) => {
    async function climberWithOnlyThatRow(): Promise<string> {
      const climberId = await createUser('one-row');
      await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
      await probeTable.insertOnlyRow(climberId, await createApp(await createUser('developer')));
      expect(await probeTable.liveRows(climberId)).toBe(1);
      return climberId;
    }

    it('has that row ended by a password write', async () => {
      const climberId = await climberWithOnlyThatRow();
      await db.update(userCredentials).set({ passwordHash: NEW_HASH }).where(eq(userCredentials.userId, climberId));
      expect(await probeTable.liveRows(climberId)).toBe(0);
    });

    it(
      'fails a contended password write rather than skip that row',
      async () => {
        await setLockBudget(SHORT_LOCK_BUDGET);
        const climberId = await climberWithOnlyThatRow();
        const holder = await openSession();
        await holder.sql`BEGIN`;
        await holder.sql`SELECT id FROM users WHERE id = ${climberId} FOR SHARE`;

        await expect(
          pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${climberId}`,
        ).rejects.toMatchObject({ code: '55P03' });

        expect(await passwordHashOf(climberId)).toBe(PASSWORD_HASH);
        expect(await probeTable.liveRows(climberId)).toBe(1);
      },
      RACE_TIMEOUT_MS,
    );
  });

  it('refuses a credential write under REPEATABLE READ rather than miss a concurrent token', async () => {
    const rows = await seedConnectedClimber();
    const session = await openSession();
    await session.sql`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await expect(
      session.sql`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`,
    ).rejects.toMatchObject({ code: '55000' });
    await session.sql`ROLLBACK`;
    expect(await passwordHashOf(rows.climberId)).toBe(PASSWORD_HASH);
    await expectIntact(rows);
  });

  it('fails the credential write and rolls it back on any other revocation error', async () => {
    const rows = await seedConnectedClimber();
    await pool`ALTER TABLE oauth_consent RENAME TO oauth_consent_broken`;
    try {
      await expect(
        pool`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`,
      ).rejects.toMatchObject({ code: '42P01' });
    } finally {
      await pool`ALTER TABLE oauth_consent_broken RENAME TO oauth_consent`;
    }
    expect(await passwordHashOf(rows.climberId)).toBe(PASSWORD_HASH);
    await expectIntact(rows);
  });
});

describe('migration retry guard', () => {
  it(
    'gives up a blocked attempt after 3 s and retries, so a stuck writer cannot queue later writes',
    async () => {
      const statements = migrationStatements();
      const guardIndex = statements.findIndex((statement) =>
        statement.includes('LOCK TABLE "user_credentials" IN SHARE ROW EXCLUSIVE MODE'),
      );
      const firstTriggerIndex = statements.findIndex((statement) => /^CREATE TRIGGER /m.test(statement));
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(firstTriggerIndex);

      const stuck = await seedConnectedClimber();
      const later = await seedConnectedClimber();
      const stuckWriter = await openSession();
      const migration = await openSession();

      await stuckWriter.sql`BEGIN`;
      await stuckWriter.sql`UPDATE user_credentials SET updated_at = updated_at WHERE user_id = ${stuck.climberId}`;

      await migration.sql`BEGIN`;
      const guard = migration.sql.unsafe(statements[guardIndex]).execute();
      await waitUntilBlocked(migration.pid);

      // Queued behind the guard's request, this write goes through when the attempt gives up.
      const startedAt = performance.now();
      await withinDeadline(
        pool`UPDATE user_credentials SET updated_at = updated_at WHERE user_id = ${later.climberId}`,
        'later write',
      );
      expect(performance.now() - startedAt).toBeLessThan(GUARD_ATTEMPT_ALLOWANCE_MS);

      await stuckWriter.sql`COMMIT`;
      await withinDeadline(guard, 'retry guard');
      await migration.sql`ROLLBACK`;
    },
    RACE_TIMEOUT_MS,
  );
});

describe('function hardening', () => {
  const restrictedRole = `partner_revoke_probe_${randomUUID().replaceAll('-', '')}`;
  const restrictedPassword = randomBytes(24).toString('hex');
  let restricted: RawSql;

  beforeAll(async () => {
    await pool.unsafe(`CREATE ROLE "${restrictedRole}" LOGIN PASSWORD '${restrictedPassword}' NOINHERIT`);
    // Reconcile grants every runtime role EXECUTE on routines, so the probe gets it too.
    await pool.unsafe(`GRANT EXECUTE ON FUNCTION public.partner_revoke_on_credential_change() TO "${restrictedRole}"`);
    const url = new URL(getWorkerDatabaseUrl());
    url.username = restrictedRole;
    url.password = restrictedPassword;
    restricted = postgres(url.toString(), { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await restricted.end({ timeout: 5 });
    await pool.unsafe(`DROP OWNED BY "${restrictedRole}"; DROP ROLE "${restrictedRole}"`);
  });

  it('pins search_path on both functions and is definer only on the trigger function', async () => {
    const [revokeUser] = await pool`
      SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.partner_revoke_user(text)'::regprocedure`;
    const [triggerFunction] = await pool`
      SELECT prosecdef, proconfig FROM pg_proc
       WHERE oid = 'public.partner_revoke_on_credential_change()'::regprocedure`;
    expect(revokeUser.prosecdef).toBe(false);
    expect(revokeUser.proconfig).toEqual(expect.arrayContaining(['search_path=public, pg_catalog', 'lock_timeout=5s']));
    expect(triggerFunction.prosecdef).toBe(true);
    expect(triggerFunction.proconfig).toEqual(expect.arrayContaining(['search_path=public, pg_catalog']));
  });

  it('gives PUBLIC no EXECUTE on the definer function', async () => {
    const [row] = await pool`
      SELECT coalesce(bool_or(privilege.grantee = 0), false) AS public_execute
        FROM pg_proc AS proc
       CROSS JOIN LATERAL aclexplode(proc.proacl) AS privilege
       WHERE proc.oid = 'public.partner_revoke_on_credential_change()'::regprocedure`;
    expect(row.public_execute).toBe(false);
  });

  it('runs partner_revoke_user as the caller, so a forged user id cannot exceed the caller rights', async () => {
    const rows = await seedConnectedClimber();
    await expect(restricted`SELECT public.partner_revoke_user(${rows.climberId})`).rejects.toMatchObject({
      code: '42501',
    });
    await expectIntact(rows);
  });

  it('refuses a forged NEW row by attaching the definer trigger function to a caller-owned table', async () => {
    const rows = await seedConnectedClimber();
    const attempt = restricted.begin(async (tx) => {
      await tx`SET LOCAL search_path = pg_temp, public`;
      await tx.unsafe(`
        CREATE TEMP TABLE user_credentials (user_id text, password_hash text, updated_at timestamp) ON COMMIT DROP;
        CREATE TRIGGER forged BEFORE INSERT ON pg_temp.user_credentials
          FOR EACH ROW EXECUTE FUNCTION public.partner_revoke_on_credential_change();
      `);
      await tx`INSERT INTO pg_temp.user_credentials (user_id, password_hash) VALUES (${rows.climberId}, 'forged')`;
    });
    await expect(attempt).rejects.toMatchObject({ code: '42501' });
    await expectIntact(rows);
  });

  it('lets a password write through a role with no partner grants, as staged current-store roles are', async () => {
    const rows = await seedConnectedClimber();
    await pool.unsafe(`GRANT SELECT, UPDATE ON TABLE user_credentials TO "${restrictedRole}"`);
    try {
      await restricted`UPDATE user_credentials SET password_hash = ${NEW_HASH} WHERE user_id = ${rows.climberId}`;
    } finally {
      await pool.unsafe(`REVOKE ALL ON TABLE user_credentials FROM "${restrictedRole}"`);
    }
    await expectRevoked(rows);
  });
});
