import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  mobileRefreshTokens,
  sessions,
  userCredentials,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import {
  SYSTEM_BOARD_OWNER_EMAIL,
  SYSTEM_BOARD_OWNER_ID,
  SYSTEM_BOARD_OWNER_NAME,
} from '@boardsesh/db/queries/constants';
import { db } from '../../../db/client';
import { currentStoreSystemBoardOwnerConfiguration } from '../authority-configuration';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  CurrentStoreFoundationError,
  type ExpectedCurrentStoreAuthority,
} from '../foundation-context';
import { insertReservedPasswordIdentity } from '../reserved-password-registration';
import { ensureReservedSystemBoardOwner } from '../system-board-owner';

let authority: ExpectedCurrentStoreAuthority;
const deniedRole = `ba03_system_owner_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomBytes(32).toString('hex');
let roleCreated = false;
let deniedPool: ReturnType<typeof postgres> | undefined;

async function prepare() {
  const projectionId = randomUUID();
  await db.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    // Disposable fixture preparation only; no production activation API exists.
    await transaction
      .update(authEmailProjection)
      .set({ phase: 'enforced' })
      .where(eq(authEmailProjection.projectionId, projectionId));
  });
  authority = {
    expectedProjectionId: projectionId,
    expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    expectedWriterEpoch: 1,
  };
}
async function snapshot() {
  return {
    users: await db.select().from(users),
    reservations: await db.select().from(authEmailReservations),
    members: await db.select().from(authEmailReservationMembers),
    cutoffs: await db.select().from(authSubjectCutoffs),
    credentials: await db.select().from(userCredentials),
    accounts: await db.select().from(accounts),
    sessions: await db.select().from(sessions),
    refresh: await db.select().from(mobileRefreshTokens),
    profiles: await db.select().from(userProfiles),
    events: await db.select().from(authSecurityMutationEvents),
  };
}
async function expectUnchangedRejection() {
  const before = await snapshot();
  await expect(ensureReservedSystemBoardOwner(db, authority)).rejects.toBeInstanceOf(CurrentStoreFoundationError);
  expect(await snapshot()).toEqual(before);
}
async function existingOwner(email = SYSTEM_BOARD_OWNER_EMAIL) {
  await db.insert(users).values({
    id: SYSTEM_BOARD_OWNER_ID,
    email,
    name: 'Existing catalogue owner',
    emailVerified: new Date('2020-01-01T00:00:00Z'),
    image: 'https://example.invalid/owner.png',
    createdAt: new Date('2019-01-01T00:00:00Z'),
    updatedAt: new Date('2021-01-01T00:00:00Z'),
  });
}

describe('fixed shared-board identity authority', () => {
  beforeAll(async () => {
    const address = new URL(process.env.DATABASE_URL!);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
      !['15475', '15478', '5433'].includes(address.port) ||
      !address.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('System owner proof requires its owned local worker database');
    await db.execute(
      sql`CREATE ROLE ${sql.identifier(deniedRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
    );
    roleCreated = true;
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(deniedRole)}`);
    // FOR UPDATE needs UPDATE privileges even though this command preserves rows.
    await db.execute(
      sql`GRANT SELECT ON TABLE ${users}, ${accounts}, ${userCredentials}, ${sessions}, ${mobileRefreshTokens}, ${authEmailProjection}, ${authSubjectCutoffs}, ${authEmailReservations}, ${authEmailReservationMembers} TO ${sql.identifier(deniedRole)}`,
    );
    await db.execute(
      sql`GRANT UPDATE ON TABLE ${users}, ${authEmailProjection}, ${authSubjectCutoffs}, ${authEmailReservations} TO ${sql.identifier(deniedRole)}`,
    );
    await db.execute(
      sql`GRANT INSERT ON TABLE ${authEmailReservations}, ${authEmailReservationMembers} TO ${sql.identifier(deniedRole)}`,
    );
    address.username = deniedRole;
    address.password = rolePassword;
    deniedPool = postgres(address.href, {
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 5000, lock_timeout: 4000 },
    });
  });
  beforeEach(async () => {
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
  });
  afterAll(async () => {
    await deniedPool?.end({ timeout: 3 });
    if (roleCreated) {
      await db.execute(
        sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${accounts}, ${userCredentials}, ${sessions}, ${mobileRefreshTokens}, ${authEmailProjection}, ${authSubjectCutoffs}, ${authEmailReservations}, ${authEmailReservationMembers} FROM ${sql.identifier(deniedRole)}`,
      );
      await db.execute(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(deniedRole)}`);
      await db.execute(sql`DROP ROLE ${sql.identifier(deniedRole)}`);
    }
  });

  it('defaults independently to legacy without requiring authority or RPC secrets', () => {
    for (const mode of [undefined, '', 'legacy'])
      expect(
        currentStoreSystemBoardOwnerConfiguration({
          CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE: mode,
          CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
          CURRENT_STORE_NATIVE_OAUTH_MODE: 'reserved-staging',
        }),
      ).toEqual({ mode: 'legacy' });
    expect(() =>
      currentStoreSystemBoardOwnerConfiguration({ CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE: 'typo' }),
    ).toThrow();
    expect(() =>
      currentStoreSystemBoardOwnerConfiguration({ CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE: 'reserved-staging' }),
    ).toThrow();
    expect(() =>
      currentStoreSystemBoardOwnerConfiguration({
        CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE: 'reserved-staging',
        CURRENT_STORE_AUTH_PROJECTION_ID: 'fixture',
        CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
        DEBUG_SQL: 'true',
      }),
    ).toThrow();
    expect(
      currentStoreSystemBoardOwnerConfiguration({
        CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE: 'reserved-staging',
        CURRENT_STORE_AUTH_PROJECTION_ID: 'fixture',
        CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
        CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-system-board-owner-digest-key-fixture',
      }),
    ).toMatchObject({
      mode: 'reserved-staging',
      authority: {
        expectedProjectionId: 'fixture',
        expectedWriterEpoch: 1,
        expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      },
    });
  });
  it('atomically creates only the fixed user, reservation and membership', async () => {
    await prepare();
    await ensureReservedSystemBoardOwner(db, authority);
    const created = await snapshot();
    expect(created.users).toHaveLength(1);
    expect(created.users[0]).toMatchObject({
      id: SYSTEM_BOARD_OWNER_ID,
      email: SYSTEM_BOARD_OWNER_EMAIL,
      name: SYSTEM_BOARD_OWNER_NAME,
      emailVerified: null,
      image: null,
    });
    expect(created.users[0].createdAt).toBeInstanceOf(Date);
    expect(created.reservations).toHaveLength(1);
    expect(created.reservations[0]).toMatchObject({
      normalizedEmail: SYSTEM_BOARD_OWNER_EMAIL,
      ownerUserId: SYSTEM_BOARD_OWNER_ID,
      state: 'owned',
      basisProjectionId: authority.expectedProjectionId,
    });
    expect(created.members).toHaveLength(1);
    expect(created.members[0]).toMatchObject({
      normalizedEmail: SYSTEM_BOARD_OWNER_EMAIL,
      userId: SYSTEM_BOARD_OWNER_ID,
    });
    for (const field of ['credentials', 'accounts', 'sessions', 'refresh', 'profiles', 'events', 'cutoffs'] as const)
      expect(created[field]).toEqual([]);
  });
  it('retries after a lost caller acknowledgement without changing committed rows', async () => {
    await prepare();
    await ensureReservedSystemBoardOwner(db, authority);
    const committed = await snapshot();
    await ensureReservedSystemBoardOwner(db, authority);
    expect(await snapshot()).toEqual(committed);
  });
  it('preserves every existing user, profile and nondeleted cutoff field', async () => {
    await existingOwner('  SYSTEM@Boardsesh.com  ');
    await db
      .insert(userProfiles)
      .values({ userId: SYSTEM_BOARD_OWNER_ID, displayName: 'Existing display name', isPrivate: true });
    await db.insert(authSubjectCutoffs).values({
      userId: SYSTEM_BOARD_OWNER_ID,
      generation: 7,
      revokedThrough: new Date('2023-01-01T00:00:00Z'),
      lastOperationId: 'existing-cutoff',
    });
    await prepare();
    const before = await snapshot();
    await ensureReservedSystemBoardOwner(db, authority);
    expect(await snapshot()).toEqual(before);
  });
  it('rejects missing or unprepared authority without writing identity state', async () => {
    authority = {
      expectedProjectionId: 'absent',
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await expectUnchangedRejection();
    await prepare();
    await db.update(authEmailProjection).set({ phase: 'prepared' });
    await expectUnchangedRejection();
  });
  it.each(['projection', 'normalizer', 'epoch'] as const)('rejects stale %s', async (field) => {
    await prepare();
    authority = {
      ...authority,
      ...(field === 'projection'
        ? { expectedProjectionId: 'stale' }
        : field === 'normalizer'
          ? { expectedNormalizerVersion: 'stale' }
          : { expectedWriterEpoch: 2 }),
    };
    await expectUnchangedRejection();
  });
  it('rejects an existing fixed UID without its reservation', async () => {
    await prepare();
    await existingOwner();
    await expectUnchangedRejection();
  });
  it('rejects a fixed UID with a different stored email', async () => {
    await existingOwner();
    await prepare();
    // Keep the target pair valid so only the stored-email mismatch rejects.
    await db.update(users).set({ email: 'someone-else@example.invalid' }).where(eq(users.id, SYSTEM_BOARD_OWNER_ID));
    await expectUnchangedRejection();
  });
  it('rejects an occupied normalized email belonging to another UID', async () => {
    await db.insert(users).values({ id: 'foreign-owner', email: ' SYSTEM@BOARDSESH.COM ' });
    await prepare();
    await expectUnchangedRejection();
  });
  it('rejects a foreign reservation owner while the fixed user and membership still match', async () => {
    await existingOwner();
    await prepare();
    await db.update(authEmailReservations).set({ ownerUserId: 'foreign-owner' });
    await expectUnchangedRejection();
  });
  it.each(['blocked_ambiguous', 'blocked_deleted', 'blocked_invalid'] as const)(
    'rejects an existing owner with a %s target key',
    async (state) => {
      await existingOwner();
      await prepare();
      await db.update(authEmailReservations).set({ state, ownerUserId: null });
      await expectUnchangedRejection();
    },
  );
  it('rejects an exact legacy row omitted from the prepared projection', async () => {
    await prepare();
    await db.insert(users).values({ id: 'unfenced-legacy-owner', email: SYSTEM_BOARD_OWNER_EMAIL });
    await expectUnchangedRejection();
  });
  it.each(['blocked_ambiguous', 'blocked_deleted', 'blocked_invalid'] as const)(
    'preserves a %s reservation',
    async (state) => {
      await prepare();
      await db.insert(authEmailReservations).values({
        normalizedEmail: SYSTEM_BOARD_OWNER_EMAIL,
        basisProjectionId: authority.expectedProjectionId,
        state,
        ownerUserId: null,
      });
      await expectUnchangedRejection();
    },
  );
  it('does not resurrect an owner deleted without a cutoff', async () => {
    await existingOwner();
    await prepare();
    await db.delete(users);
    await expectUnchangedRejection();
  });
  it.each([false, true])('rejects an absent UID with retained cutoff, deleted=%s', async (deleted) => {
    await prepare();
    await db.insert(authSubjectCutoffs).values({
      userId: SYSTEM_BOARD_OWNER_ID,
      generation: 1,
      revokedThrough: new Date(),
      deletedAt: deleted ? new Date() : null,
      lastOperationId: 'retained-cutoff',
    });
    await expectUnchangedRejection();
  });
  it('rejects a tombstoned existing owner', async () => {
    await existingOwner();
    await prepare();
    await db.insert(authSubjectCutoffs).values({
      userId: SYSTEM_BOARD_OWNER_ID,
      generation: 1,
      revokedThrough: new Date(),
      deletedAt: new Date(),
      lastOperationId: 'deleted-cutoff',
    });
    await expectUnchangedRejection();
  });
  it.each(['missing', 'foreign', 'extra'] as const)('rejects %s reservation membership', async (kind) => {
    await existingOwner();
    await prepare();
    if (kind !== 'extra') await db.delete(authEmailReservationMembers);
    if (kind !== 'missing')
      await db
        .insert(authEmailReservationMembers)
        .values({ normalizedEmail: SYSTEM_BOARD_OWNER_EMAIL, userId: 'foreign-member' });
    await expectUnchangedRejection();
  });
  it('rejects a reservation from an older projection', async () => {
    await existingOwner();
    await prepare();
    await db.insert(authEmailProjection).values({
      projectionId: 'old-projection',
      isCurrent: false,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      phase: 'prepared',
      writerEpoch: 1,
      preparedAt: new Date(),
    });
    await db.update(authEmailReservations).set({ basisProjectionId: 'old-projection' });
    await expectUnchangedRejection();
  });
  it.each(['owner', 'member'] as const)('rejects historical other-key %s evidence before recreation', async (kind) => {
    await prepare();
    await db.insert(authEmailReservations).values({
      normalizedEmail: 'historical@example.invalid',
      basisProjectionId: authority.expectedProjectionId,
      state: kind === 'owner' ? 'owned' : 'blocked_deleted',
      ownerUserId: kind === 'owner' ? SYSTEM_BOARD_OWNER_ID : null,
    });
    if (kind === 'member')
      await db
        .insert(authEmailReservationMembers)
        .values({ normalizedEmail: 'historical@example.invalid', userId: SYSTEM_BOARD_OWNER_ID });
    await expectUnchangedRejection();
  });
  it.each(['password', 'provider', 'session', 'expired-refresh', 'revoked-refresh'] as const)(
    'preserves and rejects unexpected %s history',
    async (kind) => {
      await existingOwner();
      await prepare();
      if (kind === 'password')
        await db
          .insert(userCredentials)
          .values({ userId: SYSTEM_BOARD_OWNER_ID, passwordHash: 'fixture-only-not-a-password' });
      else if (kind === 'provider')
        await db.insert(accounts).values({
          userId: SYSTEM_BOARD_OWNER_ID,
          type: 'oauth',
          provider: 'google',
          providerAccountId: 'fixture-subject',
        });
      else if (kind === 'session')
        await db.insert(sessions).values({
          userId: SYSTEM_BOARD_OWNER_ID,
          sessionToken: randomUUID(),
          expires: new Date('2020-01-01T00:00:00Z'),
        });
      else
        await db.insert(mobileRefreshTokens).values({
          userId: SYSTEM_BOARD_OWNER_ID,
          tokenHash: randomBytes(32).toString('hex'),
          expiresAt: new Date('2020-01-01T00:00:00Z'),
          revokedAt: kind === 'revoked-refresh' ? new Date() : null,
        });
      await expectUnchangedRejection();
    },
  );
  it('concurrent backend callers converge on one complete identity', async () => {
    await prepare();
    await Promise.all(Array.from({ length: 5 }, () => ensureReservedSystemBoardOwner(db, authority)));
    const result = await snapshot();
    expect(result.users).toHaveLength(1);
    expect(result.reservations).toHaveLength(1);
    expect(result.members).toHaveLength(1);
  });
  it('captures authority before the first asynchronous database boundary', async () => {
    await prepare();
    const mutableAuthority = { ...authority };
    const pending = ensureReservedSystemBoardOwner(db, mutableAuthority);
    mutableAuthority.expectedWriterEpoch = 2;
    await pending;
    expect((await snapshot()).users).toHaveLength(1);
  });
  it('rejects an old-snapshot isolation level before creating anything', async () => {
    await prepare();
    const pool = postgres(process.env.DATABASE_URL!, {
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { default_transaction_isolation: 'repeatable read', statement_timeout: 5000, lock_timeout: 4000 },
    });
    const before = await snapshot();
    try {
      await expect(ensureReservedSystemBoardOwner(drizzle(pool), authority)).rejects.toMatchObject({
        code: 'UNSUPPORTED_ISOLATION',
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      await pool.end({ timeout: 3 });
    }
  });
  it('serializes against current-store password registration for the normalized key', async () => {
    await prepare();
    const email = SYSTEM_BOARD_OWNER_EMAIL;
    const registration = db.transaction((transaction) =>
      insertReservedPasswordIdentity(transaction, authority, {
        email,
        emailVerificationEnabled: false,
        prepared: { email, passwordHash: 'fixture-only-not-a-password' },
      }),
    );
    const results = await Promise.allSettled([ensureReservedSystemBoardOwner(db, authority), registration]);
    const result = await snapshot();
    expect(result.users).toHaveLength(1);
    expect(result.reservations).toHaveLength(1);
    expect(result.members).toHaveLength(1);
    expect(result.reservations[0].ownerUserId).toBe(result.users[0].id);
    expect(result.members[0].userId).toBe(result.users[0].id);
    const [systemOutcome, registrationOutcome] = results;
    expect(registrationOutcome.status).toBe('fulfilled');
    if (result.users[0].id === SYSTEM_BOARD_OWNER_ID) {
      expect(systemOutcome.status).toBe('fulfilled');
      expect(registrationOutcome).toMatchObject({ status: 'fulfilled', value: { outcome: 'exists' } });
      expect(result.credentials).toEqual([]);
      expect(result.profiles).toEqual([]);
    } else {
      expect(systemOutcome).toMatchObject({ status: 'rejected', reason: { code: 'RESERVATION_INCONSISTENT' } });
      expect(registrationOutcome).toMatchObject({
        status: 'fulfilled',
        value: { outcome: 'created', identity: { userId: result.users[0].id } },
      });
      expect(result.credentials).toHaveLength(1);
      expect(result.profiles).toHaveLength(1);
    }
  });
  it('refuses to pass an uncommitted authentication artifact, without a long manifest hold', async () => {
    await prepare();
    await ensureReservedSystemBoardOwner(db, authority);
    let releaseArtifact = () => {};
    const artifactCanCommit = new Promise<void>((resolve) => {
      releaseArtifact = resolve;
    });
    let reportInserted = () => {};
    const artifactInserted = new Promise<void>((resolve) => {
      reportInserted = resolve;
    });
    // The session's foreign key takes KEY SHARE on the fixed user until commit.
    const artifact = db.transaction(async (transaction) => {
      await transaction.insert(sessions).values({
        userId: SYSTEM_BOARD_OWNER_ID,
        sessionToken: randomUUID(),
        expires: new Date(Date.now() + 60000),
      });
      reportInserted();
      await artifactCanCommit;
    });
    await artifactInserted;
    // Holding the manifest, so it gives up quickly rather than waiting the row out.
    const started = performance.now();
    await expect(ensureReservedSystemBoardOwner(db, authority)).rejects.toMatchObject({ cause: { code: '55P03' } });
    expect(performance.now() - started).toBeLessThan(2000);
    releaseArtifact();
    await artifact;
    await expect(ensureReservedSystemBoardOwner(db, authority)).rejects.toMatchObject({
      code: 'RESERVATION_INCONSISTENT',
    });
  });
  it('rolls back a written reservation after real SQL permission denial on user insert', async () => {
    await prepare();
    const before = await snapshot();
    await expect(ensureReservedSystemBoardOwner(drizzle(deniedPool!), authority)).rejects.toMatchObject({
      cause: { code: '42501', message: 'permission denied for table users' },
    });
    expect(await snapshot()).toEqual(before);
    // Prove the role is usable and its failure was the real INSERT privilege.
    const [privileges] =
      await deniedPool!`SELECT has_table_privilege(current_user, 'users', 'INSERT') AS can_insert, has_table_privilege(current_user, 'auth_email_reservations', 'INSERT') AS can_reserve, has_table_privilege(current_user, 'user_credentials', 'UPDATE') AS can_change_credentials`;
    expect(privileges).toMatchObject({ can_insert: false, can_reserve: true, can_change_credentials: false });
  });
});
