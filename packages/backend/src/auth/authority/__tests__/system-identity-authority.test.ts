import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  sessions,
  authAccount,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authMigrationEpochs,
  authSession,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  userProfiles,
  users,
} from '@boardsesh/db/schema';
import { SYSTEM_BOARD_OWNER_ID, SYSTEM_BOARD_OWNER_EMAIL, BATCH_SYSTEM_USERS } from '@boardsesh/db/queries/constants';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { ensureSelectedSystemIdentity, type SystemIdentityKind } from '../../current-store/system-identities';
import { ensureReservedSystemBoardOwner, ensureSelectedSystemBoardOwner } from '../../current-store/system-board-owner';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import * as adapters from '../adapter';
import * as reverseIdentity from '../reverse-identity';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
const projectionId = randomUUID();
const qualification = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const expected = { ...qualification, expectedWriterEpoch: 1 };
const kinds = ['board-owner', 'recommendations', 'hold-classifier'] as const satisfies readonly SystemIdentityKind[];

async function select(authority: IdentityAuthorityName) {
  if (authority === 'better-auth')
    await environment.database.transaction((transaction) =>
      switchIdentityAuthority(transaction, {
        projectionId,
        epoch: 1,
        from: 'current-store',
        to: 'better-auth',
      }),
    );
}
async function snapshot() {
  return {
    users: await environment.database.select().from(users),
    reservations: await environment.database.select().from(authEmailReservations),
    members: await environment.database.select().from(authEmailReservationMembers),
    canonicalAccounts: await environment.database.select().from(authAccount),
    canonicalSessions: await environment.database.select().from(authSession),
    passwords: await environment.database.select().from(userCredentials),
    refresh: await environment.database.select().from(mobileRefreshTokens),
    profiles: await environment.database.select().from(userProfiles),
    cutoffs: await environment.database.select().from(authSubjectCutoffs),
  };
}
function ensure(kind: SystemIdentityKind) {
  return environment.database.transaction((transaction) =>
    ensureSelectedSystemIdentity(transaction, qualification, kind),
  );
}
beforeAll(async () => {
  environment = await createEnvironment();
});
afterAll(async () => environment?.close());
beforeEach(async () => {
  vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
  vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-system-authority-deletion-digest-fixture-key');
  await environment.database.delete(authMigrationEpochs);
  await environment.database.delete(authEmailReservationMembers);
  await environment.database.delete(authEmailReservations);
  await environment.database.delete(authSubjectCutoffs);
  await environment.database.delete(authEmailProjection);
  await environment.database.delete(users);
  await environment.database.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    await transaction.update(authEmailProjection).set({ phase: 'enforced' });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(['current-store', 'better-auth'] as const)('selected %s system identities', (authority) => {
  it.each(kinds)('creates only the fixed %s identity and its owned reservation', async (kind) => {
    await select(authority);
    await ensure(kind);
    const result = await snapshot();
    const userId = kind === 'board-owner' ? SYSTEM_BOARD_OWNER_ID : BATCH_SYSTEM_USERS[kind].id;
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({ id: userId, emailVerified: null, image: null });
    expect(result.reservations).toHaveLength(1);
    expect(result.reservations[0]).toMatchObject({
      ownerUserId: userId,
      basisProjectionId: projectionId,
      state: 'owned',
    });
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({ userId, normalizedEmail: result.reservations[0].normalizedEmail });
    for (const field of [
      'canonicalAccounts',
      'canonicalSessions',
      'passwords',
      'refresh',
      'profiles',
      'cutoffs',
    ] as const)
      expect(result[field]).toHaveLength(0);
  });
  it('reuses an existing identity without rewriting any stored field', async () => {
    await select(authority);
    await ensureSelectedSystemBoardOwner(environment.database, qualification);
    const before = await snapshot();
    await ensureSelectedSystemBoardOwner(environment.database, qualification);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['account', 'session'] as const)('rejects canonical %s history on the fixed principal', async (artifact) => {
    await select(authority);
    await ensure('board-owner');
    if (artifact === 'account')
      await environment.database.insert(authAccount).values({
        id: randomUUID(),
        userId: SYSTEM_BOARD_OWNER_ID,
        providerId: 'credential',
        accountId: SYSTEM_BOARD_OWNER_ID,
        password: 'synthetic-unusable-password',
        sourceGeneration: 0,
      });
    else
      await environment.database.insert(authSession).values({
        id: randomUUID(),
        userId: SYSTEM_BOARD_OWNER_ID,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      });
    const before = await snapshot();
    await expect(ensure('board-owner')).rejects.toMatchObject({ code: 'RESERVATION_INCONSISTENT' });
    expect(await snapshot()).toEqual(before);
  });
});
it('refuses the explicit old writer under BetterAuth even with mirroring off', async () => {
  await select('better-auth');
  const before = await snapshot();
  await expect(
    ensureReservedSystemBoardOwner(environment.database, { ...expected, expectedWriterEpoch: 2 }),
  ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
  expect(await snapshot()).toEqual(before);
});
it('retains explicit stale-epoch rejection in the legacy entry point', async () => {
  await expect(
    ensureReservedSystemBoardOwner(environment.database, { ...expected, expectedWriterEpoch: 2 }),
  ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
  expect((await snapshot()).users).toHaveLength(0);
});
it('captures command qualification before its first await', async () => {
  await select('better-auth');
  const mutable = { ...qualification };
  const pending = ensureSelectedSystemBoardOwner(environment.database, mutable);
  Object.assign(mutable, { expectedProjectionId: 'reused', expectedNormalizerVersion: 'reused' });
  await pending;
  expect((await snapshot()).users).toHaveLength(1);
});
it('rolls back reservation and identity when the actual selected adapter refuses creation', async () => {
  await select('better-auth');
  const originalFactory = adapters.createAuthorityAdapter;
  vi.spyOn(adapters, 'createAuthorityAdapter').mockImplementation((transaction) => {
    const originalAdapter = originalFactory(transaction);
    return (options) => {
      const adapter = originalAdapter(options);
      return new Proxy(adapter, {
        get(target, property) {
          if (property === 'create')
            return async () => {
              throw new Error('Synthetic primary create refusal');
            };
          return Reflect.get(target, property);
        },
      });
    };
  });
  const before = await snapshot();
  await expect(ensure('board-owner')).rejects.toThrow('Synthetic primary create refusal');
  expect(await snapshot()).toEqual(before);
});
it('rolls back creation when the required reverse mirror fails with mirroring off', async () => {
  await select('better-auth');
  vi.spyOn(reverseIdentity, 'mirrorAuthorityToCurrentStore').mockRejectedValueOnce(
    new Error('Synthetic reverse refusal'),
  );
  const before = await snapshot();
  await expect(ensure('board-owner')).rejects.toThrow('Synthetic reverse refusal');
  expect(await snapshot()).toEqual(before);
});
it('refuses an absent projection without bootstrapping an authority', async () => {
  await environment.database.delete(authEmailProjection);
  await expect(ensure('board-owner')).rejects.toMatchObject({ code: 'AUTHORITY_NOT_ENFORCED' });
  expect((await snapshot()).users).toHaveLength(0);
});
it('refuses caller-selected identities outside the fixed catalog', async () => {
  await expect(ensure('not-a-system-identity' as SystemIdentityKind)).rejects.toMatchObject({
    code: 'INVALID_COMMAND',
  });
  expect((await snapshot()).users).toHaveLength(0);
});

it('keeps the explicit legacy default usable on the default current-store manifest', async () => {
  await expect(ensureReservedSystemBoardOwner(environment.database, expected)).resolves.toBeUndefined();
  expect((await snapshot()).users).toHaveLength(1);
});
it('the generated manifest constraint refuses an unrecognized writer', async () => {
  await expect(
    environment.database.update(authEmailProjection).set({ writerAuthority: 'unrecognized' as IdentityAuthorityName }),
  ).rejects.toMatchObject({ cause: { code: '23514' } });
});

it.each(['current-store', 'better-auth'] as const)(
  'refuses to bootstrap a fixed normalized key held by a differently cased unprojected %s owner',
  async (authority) => {
    await select(authority);
    await environment.database.insert(users).values({
      id: randomUUID(),
      email: SYSTEM_BOARD_OWNER_EMAIL.toUpperCase(),
      name: 'Existing other owner',
    });
    const before = await snapshot();
    await expect(ensure('board-owner')).rejects.toMatchObject({ code: 'RESERVATION_INCONSISTENT' });
    expect(await snapshot()).toEqual(before);
  },
);

it.each(['current-store', 'better-auth'] as const)(
  'canonical artifact reads cannot hide the actual %s user INSERT denial',
  async (authority) => {
    await select(authority);
    const role = `system_review_${randomUUID().replaceAll('-', '')}`;
    await environment.database.execute(
      sql`CREATE ROLE ${sql.identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await environment.database.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await environment.database.execute(
        sql`GRANT SELECT ON TABLE ${users}, ${accounts}, ${sessions}, ${userCredentials}, ${mobileRefreshTokens}, ${authAccount}, ${authSession}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs} TO ${sql.identifier(role)}`,
      );
      await environment.database.execute(
        sql`GRANT UPDATE ON TABLE ${users}, ${authEmailReservations}, ${authSubjectCutoffs} TO ${sql.identifier(role)}`,
      );
      await environment.database.execute(
        sql`GRANT INSERT ON TABLE ${authEmailReservations}, ${authEmailReservationMembers} TO ${sql.identifier(role)}`,
      );
      const privileges = await environment.database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
        return executeFirstRow<{ can_insert: boolean; can_read_accounts: boolean; can_read_sessions: boolean }>(
          transaction,
          sql`SELECT has_table_privilege(current_user, 'users', 'INSERT') AS can_insert,
          has_table_privilege(current_user, 'auth_account', 'SELECT') AS can_read_accounts,
          has_table_privilege(current_user, 'auth_session', 'SELECT') AS can_read_sessions`,
        );
      });
      expect(privileges).toEqual({ can_insert: false, can_read_accounts: true, can_read_sessions: true });
      const before = await snapshot();
      await expect(
        environment.database.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
          await ensureSelectedSystemIdentity(transaction, qualification, 'board-owner');
        }),
      ).rejects.toMatchObject({ cause: { code: '42501', message: 'permission denied for table users' } });
      expect(await snapshot()).toEqual(before);
    } finally {
      await environment.database.execute(
        sql`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${sql.identifier(role)}`,
      );
      await environment.database.execute(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      await environment.database.execute(sql`DROP ROLE ${sql.identifier(role)}`);
    }
  },
);

it.each(['password', 'provider', 'session', 'refresh'] as const)(
  'retains refusal of legacy %s authentication artifacts',
  async (artifact) => {
    await select('better-auth');
    await ensure('board-owner');
    if (artifact === 'password')
      await environment.database
        .insert(userCredentials)
        .values({ userId: SYSTEM_BOARD_OWNER_ID, passwordHash: 'synthetic-not-used' });
    if (artifact === 'provider')
      await environment.database
        .insert(accounts)
        .values({ userId: SYSTEM_BOARD_OWNER_ID, type: 'oauth', provider: 'google', providerAccountId: randomUUID() });
    if (artifact === 'session')
      await environment.database
        .insert(sessions)
        .values({ userId: SYSTEM_BOARD_OWNER_ID, sessionToken: randomUUID(), expires: new Date(Date.now() - 1000) });
    if (artifact === 'refresh')
      await environment.database.insert(mobileRefreshTokens).values({
        userId: SYSTEM_BOARD_OWNER_ID,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: new Date(),
      });
    const before = await snapshot();
    await expect(ensure('board-owner')).rejects.toMatchObject({ code: 'RESERVATION_INCONSISTENT' });
    expect(await snapshot()).toEqual(before);
  },
);

it('revalidates the exact receipt before committing a primary create and reverse mirror', async () => {
  await select('better-auth');
  const originalFactory = adapters.createAuthorityAdapter;
  vi.spyOn(adapters, 'createAuthorityAdapter').mockImplementation((transaction) => {
    const originalAdapter = originalFactory(transaction);
    return (options) => {
      const adapter = originalAdapter(options);
      return new Proxy(adapter, {
        get(target, property) {
          if (property === 'create')
            return async (...parameters: Parameters<typeof adapter.create>) => {
              const result = await adapter.create(...parameters);
              await transaction.update(authEmailProjection).set({ writerEpoch: 3 });
              return result;
            };
          return Reflect.get(target, property);
        },
      });
    };
  });
  const before = await snapshot();
  await expect(ensure('board-owner')).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
  expect(await snapshot()).toEqual(before);
  expect((await environment.database.select().from(authEmailProjection))[0].writerEpoch).toBe(2);
});

it.each(['missing-member', 'wrong-owner', 'ambiguous-key', 'other-key'] as const)(
  'refuses incomplete or conflicting existing fixed-principal ownership: %s',
  async (fault) => {
    await select('better-auth');
    await ensure('board-owner');
    if (fault === 'missing-member') await environment.database.delete(authEmailReservationMembers);
    if (fault === 'wrong-owner')
      await environment.database.update(authEmailReservations).set({ ownerUserId: randomUUID() });
    if (fault === 'ambiguous-key')
      await environment.database.update(authEmailReservations).set({ state: 'blocked_ambiguous', ownerUserId: null });
    if (fault === 'other-key') {
      const normalizedEmail = 'other-owned-key@example.test';
      await environment.database.insert(authEmailReservations).values({
        normalizedEmail,
        basisProjectionId: projectionId,
        state: 'owned',
        ownerUserId: SYSTEM_BOARD_OWNER_ID,
      });
      await environment.database
        .insert(authEmailReservationMembers)
        .values({ normalizedEmail, userId: SYSTEM_BOARD_OWNER_ID });
    }
    const before = await snapshot();
    await expect(ensure('board-owner')).rejects.toMatchObject({ code: 'RESERVATION_INCONSISTENT' });
    expect(await snapshot()).toEqual(before);
  },
);
