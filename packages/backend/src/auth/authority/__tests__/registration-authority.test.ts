import { randomUUID } from 'node:crypto';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { compare, getRounds, hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, type RegisterCommand } from '@boardsesh/auth-protocol';
import {
  authAccount,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authEmailVerificationTokens,
  authEmailVerificationState,
  mobileRefreshTokens,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, lockEmailKeyForCreation } from '../../current-store/foundation-context';
import { insertReservedPasswordIdentity } from '../../current-store/reserved-password-registration';
import { insertCurrentStorePasswordIdentity } from '../../current-store/password-identity';
import { registerWebPassword } from '../../current-store/web-password';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { assertLegacyIdentityWriterAllowed } from '../../current-store/identity-writer-gate';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';
import * as reverseIdentity from '../reverse-identity';
import * as forwardIdentity from '../sync-identity';

// Native registration receives this suite's transaction-aware database explicitly.
// Any accidental fallback to the process singleton must fail without connecting.
vi.mock('../../../db/client', () => {
  const unused = new Proxy(
    {},
    {
      get() {
        throw new Error('Registration fixture used an uninjected database');
      },
    },
  );
  return { db: unused, dbRead: unused };
});

const hashPhase = vi.hoisted(() => ({ afterHash: undefined as (() => Promise<void>) | undefined }));
vi.mock('bcryptjs', async (original) => {
  const actual = await original<typeof import('bcryptjs')>();
  return {
    ...actual,
    hash: async (password: string, rounds: number) => {
      const hashed = await actual.hash(password, rounds);
      await hashPhase.afterHash?.();
      return hashed;
    },
  };
});

let environment: Awaited<ReturnType<typeof createEnvironment>>;
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  // A process's configured epoch stays1 while the transaction captures the real receipt.
  expectedWriterEpoch: 1,
  emailVerificationEnabled: true,
};
const password = '  café 山🧗\u0000 registration password  ';
function command(email = `registration-${randomUUID()}@example.test`, verificationName?: string): RegisterCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'register',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email, password, ...(verificationName === undefined ? {} : { name: verificationName }) },
  };
}
async function selectedAuthority(to: IdentityAuthorityName) {
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    if (manifest.writerAuthority !== to)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to,
      });
  });
}
async function actualExpectation() {
  const [manifest] = await environment.database.select().from(authEmailProjection);
  return { ...authority, expectedWriterEpoch: manifest.writerEpoch };
}
async function nativeRegistration(email: string, submittedPassword = password, name?: string) {
  const request = new IncomingMessage(new Socket());
  request.method = 'POST';
  request.url = '/auth/native/register';
  request.headers = {};
  const captured = {
    statusCode: 0,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
    },
    setHeader() {},
    end(body?: string) {
      this.body = body ?? '';
    },
  };
  const pending = handleNativeAuthRegister(request, captured as unknown as ServerResponse, environment.database);
  request.emit('data', Buffer.from(JSON.stringify({ email, password: submittedPassword, ...(name ? { name } : {}) })));
  request.emit('end');
  await pending;
  return { status: captured.statusCode, body: JSON.parse(captured.body) as Record<string, unknown> };
}
async function persisted(userId: string) {
  const [user] = await environment.database.select().from(users).where(eq(users.id, userId));
  const [credential] = await environment.database
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));
  const canonical = await environment.database.select().from(authAccount).where(eq(authAccount.userId, userId));
  const profiles = await environment.database.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  const reservations = await environment.database
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.ownerUserId, userId));
  const members = await environment.database
    .select()
    .from(authEmailReservationMembers)
    .where(eq(authEmailReservationMembers.userId, userId));
  return { user, credential, canonical, profiles, reservations, members };
}
async function counts() {
  const tables = [
    users,
    userCredentials,
    userProfiles,
    authAccount,
    authEmailReservations,
    authEmailReservationMembers,
    authEmailVerificationTokens,
    authEmailVerificationState,
    mobileRefreshTokens,
    verificationTokens,
  ];
  return Promise.all(
    tables.map(
      async (table) =>
        (await environment.database.select({ count: sql<number>`count(*)::integer` }).from(table))[0].count,
    ),
  );
}

describe('transaction-bound shared web/native password registration authority', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  beforeEach(() => {
    __resetNativeAuthStateForTests();
    vi.stubEnv('DEBUG_SQL', 'false');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-registration-retired-key-owned-fixture');
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'reserved-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
    vi.stubEnv('NEXTAUTH_SECRET', 'synthetic-registration-native-signing-owned-fixture');
    vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
  });
  afterEach(async () => {
    hashPhase.afterHash = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await environment.database.update(authEmailProjection).set({ phase: 'enforced' });
    await selectedAuthority('current-store');
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected} web signup preserves normalized identity, bcrypt bytes, profile and unverified mail receipt`, async () => {
      await selectedAuthority(selected);
      if (selected === 'current-store') vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
      const typedEmail = `Mixed.${randomUUID()}@Example.test`;
      const reply = await registerWebPassword(environment.database, authority, command(typedEmail, 'Web Climber'));
      expect(reply.outcome).toBe('created');
      if (reply.outcome !== 'created') throw new Error('Expected created registration');
      const saved = await persisted(reply.userId);
      expect(saved.user).toMatchObject({
        id: reply.userId,
        email: typedEmail.toLowerCase(),
        name: 'Web Climber',
        emailVerified: null,
      });
      expect(saved.user.createdAt.toISOString()).toBe(reply.createdAt);
      expect(reply.requiresVerification).toBe(true);
      if (!reply.requiresVerification) throw new Error('Expected registration verification plan');
      expect(reply.mailPlan.recipient).toBe(typedEmail.toLowerCase());
      expect(getRounds(saved.credential.passwordHash)).toBe(12);
      expect(await compare(password, saved.credential.passwordHash)).toBe(true);
      expect(await compare(password.trim(), saved.credential.passwordHash)).toBe(false);
      expect(saved.canonical).toHaveLength(1);
      expect(saved.canonical[0]).toMatchObject({
        userId: reply.userId,
        accountId: reply.userId,
        providerId: 'credential',
        password: saved.credential.passwordHash,
        sourceGeneration: 0,
      });
      expect(saved.profiles).toHaveLength(1);
      expect(saved.profiles[0].isPrivate).toBe(false);
      expect(saved.reservations).toHaveLength(1);
      expect(saved.members).toHaveLength(1);
    });

    it(`${selected} native signup retains201 flat tokens, exact same owner and verification policy`, async () => {
      await selectedAuthority(selected);
      if (selected === 'current-store') vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
      const email = `Native.${randomUUID()}@Example.test`;
      const reply = await nativeRegistration(` ${email} `, password, '  Native Climber  ');
      expect(reply.status).toBe(201);
      expect(reply.body).toMatchObject({
        userId: expect.any(String),
        jwt: expect.any(String),
        refreshToken: expect.any(String),
        expiresAt: expect.any(String),
        accountCreation: expect.objectContaining({ accountCreated: true, provider: 'email' }),
      });
      const userId = String(reply.body.userId);
      const saved = await persisted(userId);
      expect(saved.user).toMatchObject({ id: userId, email: email.toLowerCase(), name: 'Native Climber' });
      expect(saved.user.emailVerified).toBeInstanceOf(Date);
      expect((reply.body.accountCreation as { userId: string; createdAt: string }).userId).toBe(userId);
      expect((reply.body.accountCreation as { createdAt: string }).createdAt).toBe(saved.user.createdAt.toISOString());
      expect(saved.canonical[0]).toMatchObject({
        userId,
        password: saved.credential.passwordHash,
        sourceGeneration: 0,
      });
      expect(await compare(password, saved.credential.passwordHash)).toBe(true);
      expect(saved.reservations).toEqual([
        expect.objectContaining({
          normalizedEmail: email.toLowerCase(),
          ownerUserId: userId,
          basisProjectionId: projectionId,
          state: 'owned',
        }),
      ]);
      expect(saved.members).toEqual([expect.objectContaining({ normalizedEmail: email.toLowerCase(), userId })]);
      expect(
        await environment.database
          .select()
          .from(authEmailReservationMembers)
          .where(eq(authEmailReservationMembers.normalizedEmail, email.toLowerCase())),
      ).toEqual([expect.objectContaining({ normalizedEmail: email.toLowerCase(), userId })]);
      expect(saved.profiles).toEqual([expect.objectContaining({ userId, isPrivate: false })]);
      expect(
        await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
      ).toHaveLength(1);
    });

    it(`${selected} concurrent web/native calls reserve exactly one normalized owner`, async () => {
      await selectedAuthority(selected);
      const email = `race-${randomUUID()}@example.test`;
      const replies = await Promise.all([
        registerWebPassword(environment.database, authority, command(email.toUpperCase())),
        nativeRegistration(email),
      ]);
      const [web, native] = replies;
      expect([web.outcome === 'created', native.status === 201].filter(Boolean)).toHaveLength(1);
      expect(web.outcome === 'created' ? native.status : web.code).toBe(web.outcome === 'created' ? 409 : 'exists');
      const owners = await environment.database.select().from(users).where(eq(users.email, email));
      expect(owners).toHaveLength(1);
      expect((await persisted(owners[0].id)).members).toHaveLength(1);
    });

    it(`${selected} occupied and ambiguous keys never choose an existing owner`, async () => {
      await selectedAuthority(selected);
      const email = `occupied-${randomUUID()}@example.test`;
      const first = await registerWebPassword(environment.database, authority, command(email));
      expect(first.outcome).toBe('created');
      const before = await counts();
      expect(await registerWebPassword(environment.database, authority, command(email.toUpperCase()))).toMatchObject({
        outcome: 'error',
        code: 'exists',
      });
      expect((await nativeRegistration(email)).status).toBe(409);
      expect(await counts()).toEqual([...before.slice(0, -1), before[before.length - 1] + 1]);
      // An already ambiguous reservation is unavailable, regardless of address case.
      await environment.database
        .update(authEmailReservations)
        .set({ state: 'blocked_ambiguous', ownerUserId: null })
        .where(eq(authEmailReservations.normalizedEmail, email));
      expect(await registerWebPassword(environment.database, authority, command(email.toUpperCase()))).toMatchObject({
        outcome: 'error',
        code: 'exists',
      });
    });

    it(`${selected} refuses an existing user missing its ownership projection instead of bootstrapping it`, async () => {
      await selectedAuthority(selected);
      const email = `unowned-${randomUUID()}@example.test`;
      const owner = randomUUID();
      await environment.database.insert(users).values({ id: owner, email });
      await expect(registerWebPassword(environment.database, authority, command(email))).rejects.toMatchObject({
        code: 'RESERVATION_INCONSISTENT',
      });
      expect(
        await environment.database
          .select()
          .from(authEmailReservations)
          .where(eq(authEmailReservations.normalizedEmail, email)),
      ).toEqual([]);
      expect((await persisted(owner)).credential).toBeUndefined();
    });
  }

  it('reverse mirror failure rolls back canonical user/account, legacy credential, reservation, profile and nonce', async () => {
    await selectedAuthority('better-auth');
    const before = await counts();
    const actual = reverseIdentity.mirrorAuthorityToCurrentStore;
    vi.spyOn(reverseIdentity, 'mirrorAuthorityToCurrentStore').mockImplementationOnce(async (...arguments_) => {
      await actual(...arguments_);
      throw new Error('Synthetic reverse mirror failure');
    });
    await expect(registerWebPassword(environment.database, authority, command())).rejects.toThrow(
      'Synthetic reverse mirror failure',
    );
    expect(await counts()).toEqual(before);
  });
  it('forward mirror failure rolls back the same creation transaction', async () => {
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const before = await counts();
    const actual = forwardIdentity.mirrorIdentityIfEnabled;
    vi.spyOn(forwardIdentity, 'mirrorIdentityIfEnabled').mockImplementationOnce(async (...arguments_) => {
      await actual(...arguments_);
      throw new Error('Synthetic forward mirror failure');
    });
    await expect(registerWebPassword(environment.database, authority, command())).rejects.toThrow(
      'Synthetic forward mirror failure',
    );
    expect(await counts()).toEqual(before);
  });
  it('captures authority before real bcrypt and refuses an epoch switch without any registration writes', async () => {
    const before = await counts();
    hashPhase.afterHash = async () => {
      hashPhase.afterHash = undefined;
      await selectedAuthority('better-auth');
    };
    await expect(registerWebPassword(environment.database, authority, command())).rejects.toMatchObject({
      code: 'STALE_AUTHORITY',
    });
    expect(await counts()).toEqual(before);
    expect((await registerWebPassword(environment.database, authority, command())).outcome).toBe('created');
  });
  it('native signup captures authority before real bcrypt and refuses a switch without any registration writes', async () => {
    const before = await counts();
    const email = `native-epoch-${randomUUID()}@example.test`;
    hashPhase.afterHash = async () => {
      hashPhase.afterHash = undefined;
      await selectedAuthority('better-auth');
    };
    expect((await nativeRegistration(email)).status).toBe(503);
    expect(await counts()).toEqual(before);
    // A new request captures the newly selected authority and can complete.
    const fresh = await nativeRegistration(email);
    expect(fresh.status).toBe(201);
    const saved = await persisted(String(fresh.body.userId));
    expect(saved.user.email).toBe(email);
    expect(saved.canonical).toHaveLength(1);
    expect(saved.reservations).toEqual([
      expect.objectContaining({ normalizedEmail: email, ownerUserId: saved.user.id, basisProjectionId: projectionId }),
    ]);
    expect(saved.members).toEqual([expect.objectContaining({ normalizedEmail: email, userId: saved.user.id })]);
  });
  it('keeps explicit reservation callers stale even though command entry points capture the current epoch', async () => {
    await selectedAuthority('better-auth');
    const prepared = { email: `stale-${randomUUID()}@example.test`, passwordHash: await hash(password, 4) };
    await expect(
      environment.database.transaction((transaction) =>
        insertReservedPasswordIdentity(transaction, authority, {
          email: prepared.email,
          prepared,
          emailVerificationEnabled: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
  });
  it('captures prepared credential and explicit authority before the first asynchronous gate', async () => {
    const expected = await actualExpectation();
    const email = `captured-${randomUUID()}@example.test`;
    const passwordHash = await hash(password, 4);
    const prepared = { email, passwordHash, name: 'Captured climber' };
    const inserted = await environment.database.transaction(async (transaction) => {
      const pending = insertReservedPasswordIdentity(transaction, expected, {
        email,
        prepared,
        emailVerificationEnabled: true,
      });
      prepared.passwordHash = 'mutated-after-entry';
      prepared.name = 'Changed after entry';
      expected.expectedWriterEpoch = 999;
      return pending;
    });
    expect(inserted.outcome).toBe('created');
    if (inserted.outcome !== 'created') throw new Error('Expected captured registration');
    const saved = await persisted(inserted.identity.userId);
    expect(saved.credential.passwordHash).toBe(passwordHash);
    expect(saved.user.name).toBe('Captured climber');
  });
  it('captures creation and verification dates before insertion can yield', async () => {
    const expected = await actualExpectation();
    const userId = randomUUID();
    const prepared = { email: `date-${userId}@example.test`, passwordHash: await hash(password, 4) };
    const startedAt = new Date('2026-11-11T10:00:00.123Z');
    await environment.database.transaction(async (transaction) => {
      const receipt = await captureIdentityAuthority(transaction, expected);
      await lockEmailKeyForCreation(transaction, prepared.email);
      vi.useFakeTimers({ toFake: ['Date'], now: startedAt });
      const pending = insertCurrentStorePasswordIdentity(transaction, prepared, false, userId, {
        receipt,
        reservationAuthority: expected,
      });
      vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
      await pending;
    });
    const saved = await persisted(userId);
    expect(saved.user.createdAt).toEqual(startedAt);
    expect(saved.user.emailVerified).toEqual(startedAt);
  });
  it('legacy mirror-off registration refuses an enforced Better Auth manifest before a write', async () => {
    await selectedAuthority('better-auth');
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'legacy');
    const before = await counts();
    expect((await nativeRegistration(`legacy-${randomUUID()}@example.test`)).status).toBe(503);
    await expect(environment.database.transaction(assertLegacyIdentityWriterAllowed)).rejects.toMatchObject({
      code: 'STALE_AUTHORITY',
    });
    await expect(
      environment.database.transaction((transaction) =>
        insertCurrentStorePasswordIdentity(
          transaction,
          { email: `old-${randomUUID()}@example.test`, passwordHash: 'not-written' },
          false,
        ),
      ),
    ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
    expect(await counts()).toEqual(before);
  });
  it('legacy/default no-manifest and enforced current-store writers remain compatible', async () => {
    await expect(environment.database.transaction(assertLegacyIdentityWriterAllowed)).resolves.toBeUndefined();
    const legacy = await createEnvironment();
    try {
      await expect(legacy.database.transaction(assertLegacyIdentityWriterAllowed)).resolves.toBeUndefined();
      const identity = await legacy.database.transaction((transaction) =>
        insertCurrentStorePasswordIdentity(
          transaction,
          { email: `default-${randomUUID()}@example.test`, passwordHash: 'legacy-fixture' },
          false,
        ),
      );
      expect(
        await legacy.database.select().from(userCredentials).where(eq(userCredentials.userId, identity.userId)),
      ).toHaveLength(1);
    } finally {
      await legacy.close();
    }
  });
  it('refuses a missing enforced manifest without creating projection or identity state', async () => {
    await environment.database.update(authEmailProjection).set({ phase: 'prepared' });
    const before = await counts();
    await expect(registerWebPassword(environment.database, authority, command())).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_ENFORCED',
    });
    expect(await counts()).toEqual(before);
  });
});
