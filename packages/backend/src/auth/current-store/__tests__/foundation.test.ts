import { randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  accounts,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from '../foundation-context';
import { recordSecurityMutation } from '../security-mutations';

const roleSalt = randomUUID().replaceAll('-', '');
const legacyRole = `ba03_legacy_${roleSalt}`;
const writerRole = `ba03_writer_${roleSalt}`;
const domains = ['first-party', 'partner'] as const;
const compareText = (firstText: string, secondText: string) => firstText.localeCompare(secondText);
const trackedRoles: string[] = [];

function legacyConnection() {
  return postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
    connect_timeout: 3,
    connection: { statement_timeout: 5000, lock_timeout: 4000 },
  });
}

async function waitForBarrier(signal: Promise<void>, work?: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned fixture barrier timed out')), 4000);
      }),
      ...(work
        ? [
            work.then(() => {
              throw new Error('Owned fixture work ended before its barrier');
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('unmounted current-store reservation and security mutation foundation', () => {
  let passwordHash: string;
  let replacementHash: string;
  beforeAll(async () => {
    passwordHash = await hash('foundation-original-password', 4);
    replacementHash = await hash('foundation-replacement-password', 4);
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`CREATE ROLE ${sql.identifier(legacyRole)} NOLOGIN`);
      trackedRoles.push(legacyRole);
      await transaction.execute(sql`CREATE ROLE ${sql.identifier(writerRole)} NOLOGIN`);
      trackedRoles.push(writerRole);
      // Names are tracked before COMMIT, including a lost commit acknowledgement.
    });
  });
  beforeEach(async () => {
    // Every test uses the backend harness's owned, randomly salted worker DB.
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(legacyRole)}, ${sql.identifier(writerRole)}`);
    await db.execute(
      sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${users}, ${userCredentials}, ${accounts} TO ${sql.identifier(legacyRole)}`,
    );
  });
  afterAll(async () => {
    const cleanupFailures: Error[] = [];
    for (const role of trackedRoles) {
      try {
        const existing = await executeFirstRow<{ present: boolean }>(
          db,
          sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`,
        );
        if (existing?.present === false) continue;
      } catch {
        cleanupFailures.push(new Error('Owned role cleanup catalog lookup failed'));
      }
      try {
        await db.execute(sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${accounts}, ${authEmailProjection},
          ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs}, ${authSecurityMutationEvents} FROM ${sql.identifier(role)}`);
      } catch {
        cleanupFailures.push(new Error('Owned role cleanup table-grant revocation failed'));
      }
      try {
        await db.execute(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        cleanupFailures.push(new Error('Owned role cleanup schema-grant revocation failed'));
      }
      try {
        await db.execute(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        cleanupFailures.push(new Error('Owned role cleanup drop failed'));
      }
    }
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Owned foundation role cleanup failed');
  });

  async function fixture(email = `${randomUUID()}@example.test`) {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, email });
    await db.insert(userCredentials).values({ userId, passwordHash });
    return { userId, email };
  }
  function expected(projectionId: string): ExpectedCurrentStoreAuthority {
    return {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
  }
  async function transferFixturePrivileges(transaction: CurrentStoreTransaction) {
    await transaction.execute(
      sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${accounts} FROM ${sql.identifier(legacyRole)}`,
    );
    await transaction.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${users}, ${userCredentials}, ${accounts}, ${authEmailProjection},
      ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs} TO ${sql.identifier(writerRole)}`);
    await transaction.execute(
      sql`GRANT SELECT, INSERT ON TABLE ${authSecurityMutationEvents} TO ${sql.identifier(writerRole)}`,
    );
    await transaction.execute(
      sql`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${authSecurityMutationEvents} FROM ${sql.identifier(writerRole)}`,
    );
  }
  async function enforceOwnedFixture() {
    const projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      // This is TEST-ONLY operator setup, deliberately absent from source APIs.
      // Actual table lock drains old writes; ACL transfer blocks future writes.
      await transaction.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
      await transferFixturePrivileges(transaction);
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    return expected(projectionId);
  }
  function writer<T>(operation: (transaction: CurrentStoreTransaction) => Promise<T>) {
    return db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(writerRole)}`);
      return operation(transaction);
    });
  }
  function command(authority: ExpectedCurrentStoreAuthority, userId: string, expectedGeneration = 0) {
    return {
      ...authority,
      operationId: randomUUID(),
      userId,
      expectedGeneration,
      kind: 'password-change' as const,
      domains,
    };
  }
  async function storedPassword(userId: string, candidate: string) {
    const [credential] = await db.select().from(userCredentials).where(eq(userCredentials.userId, userId));
    return credential ? compare(candidate, credential.passwordHash) : false;
  }

  it('prepares a full JS trim/lower projection without rewriting users or selecting a collision owner', async () => {
    const first = await fixture('\u00a0\uFEFFClimber+Tag@Example.TEST\u2028');
    const second = await fixture('climber+tag@example.test');
    const third = await fixture('\u3000Unique.Name@Example.TEST\uFEFF');
    const before = await db.select().from(users).orderBy(users.id);
    const manifest = await db.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
    );
    expect(manifest).toMatchObject({
      phase: 'prepared',
      sourceUserCount: 3,
      keyCount: 2,
      ambiguousKeyCount: 1,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    });
    expect(await db.select().from(users).orderBy(users.id)).toEqual(before);
    const [collision] = await db
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, 'climber+tag@example.test'));
    expect(collision).toMatchObject({ state: 'blocked_ambiguous', ownerUserId: null });
    const members = await db
      .select()
      .from(authEmailReservationMembers)
      .where(eq(authEmailReservationMembers.normalizedEmail, collision.normalizedEmail));
    expect(members.map((member) => member.userId).sort(compareText)).toEqual(
      [first.userId, second.userId].sort(compareText),
    );
    expect(
      await db
        .select()
        .from(authEmailReservations)
        .where(eq(authEmailReservations.normalizedEmail, 'unique.name@example.test')),
    ).toMatchObject([{ ownerUserId: third.userId }]);
    await expect(
      db.transaction((transaction) =>
        reserveEnforcedEmail(transaction, {
          ...expected(manifest.projectionId),
          rawEmail: 'fresh@example.test',
          requestedUserId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_ENFORCED' });
  });

  it('records an empty completed preparation and rejects every repeat instead of pretending it is a fresh reconciliation', async () => {
    const manifest = await db.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
    );
    expect(manifest).toMatchObject({ sourceUserCount: 0, keyCount: 0, phase: 'prepared' });
    await fixture();
    await expect(
      db.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'PROJECTION_EXISTS' });
    expect(await db.select().from(authEmailProjection)).toHaveLength(1);
    expect(await db.select().from(authEmailReservations)).toEqual([]);
  });

  it('two concurrent first preparations publish one complete manifest and roll back the loser', async () => {
    await fixture();
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        db.transaction((transaction) =>
          prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejectedReason: unknown = outcomes.find((outcome) => outcome.status === 'rejected')?.reason;
    expect(rejectedReason).toMatchObject({ code: 'PROJECTION_EXISTS' });
    expect(await db.select().from(authEmailProjection)).toMatchObject([
      { phase: 'prepared', sourceUserCount: 1, keyCount: 1 },
    ]);
    expect(await db.select().from(authEmailReservationMembers)).toHaveLength(1);
  });

  it('never recreates current preparation from an empty noncurrent prior manifest', async () => {
    const originalId = randomUUID();
    await db.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId: originalId }),
    );
    await db.update(authEmailProjection).set({ isCurrent: false });
    await expect(
      db.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'PROJECTION_EXISTS' });
    expect(await db.select().from(authEmailProjection)).toMatchObject([
      { projectionId: originalId, isCurrent: false, phase: 'prepared', sourceUserCount: 0 },
    ]);
    expect(await db.select().from(authEmailReservations)).toEqual([]);
  });

  it('characterizes raw legacy writes after a preparation commit as an unfenced snapshot, never activation', async () => {
    const owner = await fixture('Legacy.Before@Example.test');
    const manifest = await db.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
    );
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(legacyRole)}`);
      await transaction.insert(users).values({ id: randomUUID(), email: owner.email.toLowerCase() });
    });
    expect(await db.select().from(users)).toHaveLength(2);
    await expect(
      db.transaction((transaction) =>
        reserveEnforcedEmail(transaction, {
          ...expected(manifest.projectionId),
          rawEmail: 'new@example.test',
          requestedUserId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_ENFORCED' });
  });

  it('drains an old in-flight write, projects it, transfers real grants, and rejects its connected prepared writer', async () => {
    const legacy = legacyConnection();
    const wrote = deferred();
    const release = deferred();
    const attempted = deferred();
    let oldPid = 0;
    let fencePid = 0;
    let active: Promise<unknown> | undefined;
    let fenced: Promise<unknown> | undefined;
    try {
      await legacy.unsafe(`SET ROLE "${legacyRole}"`);
      await legacy.unsafe('PREPARE stale_user_insert(text, text) AS INSERT INTO users (id, email) VALUES ($1, $2)');
      active = legacy.begin(async (connection) => {
        const [backend] = await connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        oldPid = backend.pid;
        await connection`INSERT INTO users (id, email) VALUES (${randomUUID()}, ${'\u00a0Drained@Example.TEST\u2028'})`;
        wrote.resolve();
        await waitForBarrier(release.promise);
      });
      await waitForBarrier(wrote.promise, active);
      const projectionId = randomUUID();
      fenced = db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '4s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout = '5s'`);
        const backend = await executeFirstRow<{ pid: number }>(transaction, sql`SELECT pg_backend_pid() AS pid`);
        if (!backend) throw new Error('Missing fence connection ID');
        fencePid = backend.pid;
        attempted.resolve();
        await transaction.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
        await transferFixturePrivileges(transaction);
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction
          .update(authEmailProjection)
          .set({ phase: 'enforced' })
          .where(eq(authEmailProjection.projectionId, projectionId));
      });
      await waitForBarrier(attempted.promise, fenced);
      await vi.waitFor(async () => {
        const blocked = await executeFirstRow<{ waiting: boolean }>(
          db,
          sql`SELECT ${oldPid} = ANY(pg_blocking_pids(${fencePid})) AS waiting`,
        );
        expect(blocked?.waiting).toBe(true);
      });
      release.resolve();
      await active;
      await fenced;
      expect(await db.select().from(authEmailReservations)).toMatchObject([
        { normalizedEmail: 'drained@example.test' },
      ]);
      await expect(
        legacy.unsafe(`EXECUTE stale_user_insert('${randomUUID()}', 'blocked@example.test')`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(legacy`UPDATE users SET email = ${'changed@example.test'}`).rejects.toMatchObject({ code: '42501' });
      const newId = randomUUID();
      await writer(async (transaction) => {
        const reservation = await reserveEnforcedEmail(transaction, {
          ...expected(projectionId),
          rawEmail: ' New@Example.TEST ',
          requestedUserId: newId,
        });
        await transaction.insert(users).values({ id: newId, email: reservation.normalizedEmail });
      });
      expect(await db.select().from(users).where(eq(users.id, newId))).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([active, fenced].filter((pending): pending is Promise<unknown> => Boolean(pending)));
      await legacy.end({ timeout: 2 });
    }
  });

  it.each(['repeatable read', 'serializable'] as const)(
    'rejects %s preparation even when a paused old writer commits after the caller snapshot',
    async (isolationLevel) => {
      const legacy = legacyConnection();
      const wrote = deferred();
      const release = deferred();
      let active: Promise<unknown> | undefined;
      try {
        await legacy.unsafe(`SET ROLE "${legacyRole}"`);
        active = legacy.begin(async (connection) => {
          await connection`INSERT INTO users (id, email) VALUES (${randomUUID()}, ${'late-commit@example.test'})`;
          wrote.resolve();
          await waitForBarrier(release.promise);
        });
        await waitForBarrier(wrote.promise, active);
        await expect(
          db.transaction(
            async (transaction) => {
              expect(await transaction.select().from(users)).toEqual([]);
              release.resolve();
              await active;
              await prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() });
            },
            { isolationLevel },
          ),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_ISOLATION' });
        expect(await db.select().from(users)).toHaveLength(1);
        expect(await db.select().from(authEmailProjection)).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled(active ? [active] : []);
        await legacy.end({ timeout: 2 });
      }
    },
  );

  it.each(['reservation', 'mutation'] as const)(
    'rejects an old RR %s snapshot that predates the first deletion cutoff',
    async (operation) => {
      const actor = await fixture();
      const authority = await enforceOwnedFixture();
      const snapshotted = deferred();
      const removed = deferred();
      const attempted = db.transaction(
        async (transaction) => {
          await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(writerRole)}`);
          expect(await transaction.select().from(authSubjectCutoffs)).toEqual([]);
          snapshotted.resolve();
          await waitForBarrier(removed.promise);
          if (operation === 'reservation')
            return reserveEnforcedEmail(transaction, {
              ...authority,
              rawEmail: 'stale-new-address@example.test',
              requestedUserId: actor.userId,
            });
          return recordSecurityMutation(transaction, command(authority, actor.userId));
        },
        { isolationLevel: 'repeatable read' },
      );
      // Attach rejection observation before allowing the other transaction to run.
      const denied = expect(attempted).rejects.toMatchObject({ code: 'UNSUPPORTED_ISOLATION' });
      try {
        await waitForBarrier(snapshotted.promise, attempted);
        await writer(async (transaction) => {
          await recordSecurityMutation(transaction, { ...command(authority, actor.userId), kind: 'account-deletion' });
          await transaction.delete(users).where(eq(users.id, actor.userId));
        });
      } finally {
        removed.resolve();
      }
      await denied;
      expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(1);
      expect(
        await db
          .select()
          .from(authEmailReservations)
          .where(eq(authEmailReservations.normalizedEmail, 'stale-new-address@example.test')),
      ).toEqual([]);
    },
  );

  it.each(['missing', 'preparing', 'prepared', 'projection', 'normalizer', 'epoch', 'noncurrent'] as const)(
    'rejects %s manifest context before a reservation or mutation',
    async (condition) => {
      const authority = condition === 'missing' ? expected(randomUUID()) : await enforceOwnedFixture();
      if (condition === 'preparing') await db.update(authEmailProjection).set({ phase: 'preparing', preparedAt: null });
      if (condition === 'prepared') await db.update(authEmailProjection).set({ phase: 'prepared' });
      if (condition === 'noncurrent') await db.update(authEmailProjection).set({ isCurrent: false });
      const stale = {
        ...authority,
        ...(condition === 'projection' ? { expectedProjectionId: randomUUID() } : {}),
        ...(condition === 'normalizer' ? { expectedNormalizerVersion: 'sql-btrim-is-not-equivalent' } : {}),
        ...(condition === 'epoch' ? { expectedWriterEpoch: 2 } : {}),
      };
      await expect(
        db.transaction((transaction) =>
          reserveEnforcedEmail(transaction, {
            ...stale,
            rawEmail: 'fresh@example.test',
            requestedUserId: randomUUID(),
          }),
        ),
      ).rejects.toHaveProperty('code');
      await expect(
        db.transaction((transaction) => recordSecurityMutation(transaction, command(stale, randomUUID()))),
      ).rejects.toHaveProperty('code');
      expect(await db.select().from(authEmailReservations)).toEqual([]);
      expect(await db.select().from(authSubjectCutoffs)).toEqual([]);
      expect(await db.select().from(authSecurityMutationEvents)).toEqual([]);
    },
  );

  it('finds an occupied key across an old basis instead of treating it as free under a new current manifest', async () => {
    const owner = await fixture();
    const authority = await enforceOwnedFixture();
    await db.update(authEmailProjection).set({ isCurrent: false });
    const next = randomUUID();
    // TEST-ONLY future-state characterization, not an implemented transition.
    await db.insert(authEmailProjection).values({
      projectionId: next,
      phase: 'enforced',
      isCurrent: true,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      writerEpoch: 1,
      preparedAt: new Date(),
    });
    await expect(
      writer((transaction) =>
        reserveEnforcedEmail(transaction, { ...expected(next), rawEmail: owner.email, requestedUserId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
    expect(await db.select().from(authEmailReservations)).toMatchObject([
      { ownerUserId: owner.userId, basisProjectionId: authority.expectedProjectionId },
    ]);
  });

  it('serializes normalized registration versus social creation to one owner, without account reassignment', async () => {
    const authority = await enforceOwnedFixture();
    const first = randomUUID();
    const second = randomUUID();
    const key = `${randomUUID()}+tag@example.test`;
    const outcomes = await Promise.allSettled([
      writer(async (transaction) => {
        const reservation = await reserveEnforcedEmail(transaction, {
          ...authority,
          rawEmail: `\u00a0${key.toUpperCase()}\u2028`,
          requestedUserId: first,
        });
        await transaction.insert(users).values({ id: first, email: reservation.normalizedEmail });
        await transaction.insert(userCredentials).values({ userId: first, passwordHash });
      }),
      writer(async (transaction) => {
        const reservation = await reserveEnforcedEmail(transaction, {
          ...authority,
          rawEmail: key,
          requestedUserId: second,
        });
        await transaction.insert(users).values({ id: second, email: reservation.normalizedEmail });
        await transaction
          .insert(accounts)
          .values({ userId: second, type: 'oauth', provider: 'google', providerAccountId: randomUUID() });
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejectedReason: unknown = outcomes.find((outcome) => outcome.status === 'rejected')?.reason;
    expect(rejectedReason).toMatchObject({ code: 'EMAIL_RESERVED' });
    const [reservation] = await db
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, key));
    expect([first, second]).toContain(reservation.ownerUserId);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(authEmailReservationMembers)).toHaveLength(1);
    expect(await db.select().from(userCredentials)).toHaveLength(reservation.ownerUserId === first ? 1 : 0);
    expect(await db.select().from(accounts)).toHaveLength(reservation.ownerUserId === second ? 1 : 0);
  });

  it.each(['credential', 'social'] as const)(
    'the controlled %s creation branch independently persists its actual current-store account',
    async (kind) => {
      const authority = await enforceOwnedFixture();
      const userId = randomUUID();
      await writer(async (transaction) => {
        const reservation = await reserveEnforcedEmail(transaction, {
          ...authority,
          rawEmail: `${userId}@example.test`,
          requestedUserId: userId,
        });
        await transaction.insert(users).values({ id: userId, email: reservation.normalizedEmail });
        if (kind === 'credential') await transaction.insert(userCredentials).values({ userId, passwordHash });
        else
          await transaction
            .insert(accounts)
            .values({ userId, type: 'oauth', provider: 'google', providerAccountId: randomUUID() });
      });
      expect(await db.select().from(users)).toMatchObject([{ id: userId }]);
      if (kind === 'credential')
        expect(await db.select().from(userCredentials)).toMatchObject([{ userId, passwordHash }]);
      else expect(await db.select().from(accounts)).toMatchObject([{ userId, provider: 'google' }]);
    },
  );

  it('drops the deleted owner from an ambiguous group and never elects the survivor', async () => {
    const first = await fixture('Ambiguous@Example.test');
    const second = await fixture(' ambiguous@example.test ');
    const authority = await enforceOwnedFixture();
    await writer(async (transaction) => {
      await recordSecurityMutation(transaction, { ...command(authority, first.userId), kind: 'account-deletion' });
      await transaction.delete(users).where(eq(users.id, first.userId));
    });
    await expect(
      writer((transaction) =>
        reserveEnforcedEmail(transaction, { ...authority, rawEmail: second.email, requestedUserId: second.userId }),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_AMBIGUOUS' });
    expect(await db.select().from(authEmailReservationMembers)).toMatchObject([{ userId: second.userId }]);
    expect(await db.select().from(authEmailReservations)).toMatchObject([
      { state: 'blocked_ambiguous', ownerUserId: null },
    ]);
  });

  it('rolls back a failed new owner reservation with the caller identity write', async () => {
    const authority = await enforceOwnedFixture();
    const key = `${randomUUID()}@example.test`;
    const failedUserId = randomUUID();
    await expect(
      writer(async (transaction) => {
        const reserved = await reserveEnforcedEmail(transaction, {
          ...authority,
          rawEmail: key,
          requestedUserId: failedUserId,
        });
        await transaction.insert(users).values({ id: failedUserId, email: reserved.normalizedEmail });
        expect(await transaction.select().from(users).where(eq(users.id, failedUserId))).toHaveLength(1);
        throw new Error('Injected identity command failure');
      }),
    ).rejects.toThrow('Injected identity command failure');
    expect(await db.select().from(authEmailReservations)).toEqual([]);
    expect(await db.select().from(authEmailReservationMembers)).toEqual([]);
    expect(await db.select().from(users).where(eq(users.id, failedUserId))).toEqual([]);
    const userId = randomUUID();
    await writer(async (transaction) => {
      const reservation = await reserveEnforcedEmail(transaction, {
        ...authority,
        rawEmail: key,
        requestedUserId: userId,
      });
      await transaction.insert(users).values({ id: userId, email: reservation.normalizedEmail });
    });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('commits the real password update, durable generation and authority-neutral event together', async () => {
    const actor = await fixture();
    const authority = await enforceOwnedFixture();
    const receipt = await writer(async (transaction) => {
      await transaction
        .update(userCredentials)
        .set({ passwordHash: replacementHash })
        .where(eq(userCredentials.userId, actor.userId));
      return recordSecurityMutation(transaction, command(authority, actor.userId));
    });
    expect(await storedPassword(actor.userId, 'foundation-replacement-password')).toBe(true);
    expect(receipt.cutoff.generation).toBe(1);
    expect(receipt.event).toMatchObject({
      userId: actor.userId,
      generation: 1,
      previousGeneration: 0,
      domains: ['first-party', 'partner'],
      payloadVersion: 1,
    });
    expect(Object.keys(receipt.event).sort(compareText)).toEqual(
      [
        'operationId',
        'userId',
        'generation',
        'previousGeneration',
        'kind',
        'domains',
        'revokedThrough',
        'writerEpoch',
        'projectionId',
        'payloadVersion',
        'recordedAt',
      ].sort(compareText),
    );
    expect(receipt.event).not.toHaveProperty('email');
    expect(receipt.event).not.toHaveProperty('passwordHash');
    await expect(
      writer((transaction) => transaction.update(authSecurityMutationEvents).set({ kind: 'password-reset' })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(writer((transaction) => transaction.delete(authSecurityMutationEvents))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(
      writer((transaction) => transaction.execute(sql`TRUNCATE TABLE ${authSecurityMutationEvents}`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rolls back the caller credential update and cutoff when the actual event insert fails', async () => {
    const actor = await fixture();
    const authority = await enforceOwnedFixture();
    // Owned-test fault constraint only, never a migration or library startup DDL.
    await db.execute(
      sql`ALTER TABLE ${authSecurityMutationEvents} ADD CONSTRAINT ba03_test_reject_event CHECK (false) NOT VALID`,
    );
    try {
      await expect(
        writer(async (transaction) => {
          await transaction
            .update(userCredentials)
            .set({ passwordHash: replacementHash })
            .where(eq(userCredentials.userId, actor.userId));
          await recordSecurityMutation(transaction, command(authority, actor.userId));
        }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE ${authSecurityMutationEvents} DROP CONSTRAINT ba03_test_reject_event`);
    }
    expect(await storedPassword(actor.userId, 'foundation-original-password')).toBe(true);
    expect(await db.select().from(authSubjectCutoffs)).toEqual([]);
    expect(await db.select().from(authSecurityMutationEvents)).toEqual([]);
  });

  it('rolls back a failure after a visible in-transaction event without publishing revocation state', async () => {
    const actor = await fixture();
    const authority = await enforceOwnedFixture();
    await expect(
      writer(async (transaction) => {
        await transaction
          .update(userCredentials)
          .set({ passwordHash: replacementHash })
          .where(eq(userCredentials.userId, actor.userId));
        const recorded = await recordSecurityMutation(transaction, command(authority, actor.userId));
        expect(
          await transaction
            .select()
            .from(authSecurityMutationEvents)
            .where(eq(authSecurityMutationEvents.operationId, recorded.event.operationId)),
        ).toHaveLength(1);
        throw new Error('Injected failure before outer commit');
      }),
    ).rejects.toThrow('Injected failure before outer commit');
    expect(await storedPassword(actor.userId, 'foundation-original-password')).toBe(true);
    expect(await db.select().from(authSubjectCutoffs)).toEqual([]);
    expect(await db.select().from(authSecurityMutationEvents)).toEqual([]);
  });

  it('rejects repeated operation IDs even with changed command metadata and rolls back a second password write', async () => {
    const actor = await fixture();
    const authority = await enforceOwnedFixture();
    const original = command(authority, actor.userId);
    await writer((transaction) => recordSecurityMutation(transaction, original));
    await expect(
      writer(async (transaction) => {
        await transaction
          .update(userCredentials)
          .set({ passwordHash: replacementHash })
          .where(eq(userCredentials.userId, actor.userId));
        await recordSecurityMutation(transaction, { ...original, kind: 'password-reset', expectedGeneration: 1 });
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_OPERATION' });
    expect(await storedPassword(actor.userId, 'foundation-original-password')).toBe(true);
    expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(1);
    expect(await db.select().from(authSubjectCutoffs)).toMatchObject([{ generation: 1 }]);
  });

  it('concurrent stale generations permit one security mutation and monotonically retain an ahead-clock cutoff', async () => {
    const actor = await fixture();
    const authority = await enforceOwnedFixture();
    const ahead = new Date(Date.now() + 86_400_000);
    await db
      .insert(authSubjectCutoffs)
      .values({ userId: actor.userId, generation: 4, revokedThrough: ahead, lastOperationId: randomUUID() });
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        writer((transaction) => recordSecurityMutation(transaction, command(authority, actor.userId, 4))),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejectedReason: unknown = outcomes.find((outcome) => outcome.status === 'rejected')?.reason;
    expect(rejectedReason).toMatchObject({ code: 'STALE_GENERATION' });
    const [cutoff] = await db.select().from(authSubjectCutoffs);
    expect(cutoff.generation).toBe(5);
    expect(cutoff.revokedThrough).toEqual(ahead);
    const next = await writer((transaction) =>
      recordSecurityMutation(transaction, command(authority, actor.userId, 5)),
    );
    expect(next.cutoff.generation).toBe(6);
    expect(next.cutoff.revokedThrough).toEqual(ahead);
  });

  it('retains deleted subject cutoffs, events and only a key digest without allowing ABA reuse', async () => {
    const actor = await fixture();
    const authority = await enforceOwnedFixture();
    await writer(async (transaction) => {
      await recordSecurityMutation(transaction, { ...command(authority, actor.userId), kind: 'account-deletion' });
      await transaction.delete(users).where(eq(users.id, actor.userId));
    });
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(userCredentials)).toEqual([]);
    expect(await db.select().from(authSubjectCutoffs)).toMatchObject([
      { userId: actor.userId, generation: 1, deletedAt: expect.any(Date) },
    ]);
    expect(await db.select().from(authSecurityMutationEvents)).toMatchObject([
      { userId: actor.userId, kind: 'account-deletion' },
    ]);
    expect(await db.select().from(authEmailReservations)).toMatchObject([
      {
        normalizedEmail: expect.stringMatching(/^deleted-v1:[0-9a-f]{64}$/),
        state: 'blocked_deleted',
        ownerUserId: null,
      },
    ]);
    expect(await db.select().from(authEmailReservationMembers)).toEqual([]);
    await expect(
      writer((transaction) =>
        reserveEnforcedEmail(transaction, { ...authority, rawEmail: actor.email, requestedUserId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_RETIRED' });
    await expect(
      writer((transaction) =>
        reserveEnforcedEmail(transaction, {
          ...authority,
          rawEmail: 'different@example.test',
          requestedUserId: actor.userId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SUBJECT_DELETED' });
    await expect(
      writer((transaction) => recordSecurityMutation(transaction, command(authority, actor.userId, 1))),
    ).rejects.toMatchObject({ code: 'SUBJECT_DELETED' });
  });
});
