import { randomUUID } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { compare } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, type SetPasswordCommand } from '@boardsesh/auth-protocol';
import {
  users,
  accounts,
  authAccount,
  userCredentials,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  authEmailProjection,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { setWebPassword } from '../../current-store/set-password';
import { syncIdentity } from '../sync-identity';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import * as reverseIdentity from '../reverse-identity';
import type { IdentityGenerationMutationReceipt } from '../../current-store/security-mutation-core';
const hashPhase = vi.hoisted(() => ({ afterHash: undefined as (() => Promise<void>) | undefined }));
vi.mock('bcryptjs', async (original) => {
  const actual = await original<typeof import('bcryptjs')>();
  return {
    ...actual,
    hash: async (password: string, rounds: number) => {
      const result = await actual.hash(password, rounds);
      await hashPhase.afterHash?.();
      return result;
    },
  };
});

let environment: Awaited<ReturnType<typeof createEnvironment>>;
// Production admission uses a separate bounded connection; keep that boundary
// while routing it exclusively to this suite's disposable database.
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));

const projectionId = randomUUID();
const secret = 'synthetic-writer-set-password-secret';
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  expectedWriterEpoch: 1,
  emailVerificationEnabled: false,
};
async function fixture() {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const email = `set-${userId}@example.com`;
  await environment.database.insert(users).values({ id: userId, email, name: null });
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    await reserveEnforcedEmail(transaction, {
      ...authority,
      expectedWriterEpoch: manifest.writerEpoch,
      rawEmail: email,
      requestedUserId: userId,
    });
    await transaction
      .insert(accounts)
      .values({ userId, provider: 'google', providerAccountId: randomUUID(), type: 'oauth' });
    await syncIdentity(transaction, userId, 'current-store-to-authority');
  });
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  const now = Math.floor(Date.now() / 1000);
  const credential = await new EncryptJWT({ authSessionId: sessionId, gen: 0, auth_time: now - 20, link_guarded: true })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .encrypt(key);
  return { userId, sessionId, credential, authenticatedAt: new Date((now - 20) * 1000).toISOString() };
}
async function switchTo(to: IdentityAuthorityName) {
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
function command(owner: Awaited<ReturnType<typeof fixture>>): SetPasswordCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'set-password' as const,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: {
      credential: owner.credential,
      expectedUserId: owner.userId,
      expectedAuthSessionId: owner.sessionId,
      password: ' exact password bytes ',
      confirmPassword: ' exact password bytes ',
    },
  };
}

describe('selected authority fresh set-password command', () => {
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-writer-retired-mailbox-key-6975');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  });
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  afterEach(async () => {
    hashPhase.afterHash = undefined;
    vi.restoreAllMocks();
    await switchTo('current-store');
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const)
    it(`sets through ${selected}, mirrors exact bytes, and survives stale process epoch`, async () => {
      vi.stubEnv('NEXTAUTH_SECRET', secret);
      vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
      vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
      const owner = await fixture();
      await switchTo(selected);
      const reply = await setWebPassword(environment.database, authority, command(owner));
      expect(reply.outcome).toBe('set');
      if (reply.outcome !== 'set') throw new Error('Missing replacement proof');
      expect(reply.credentialProof).toMatchObject({
        userId: owner.userId,
        authSessionId: owner.sessionId,
        generation: 1,
        authenticatedAt: owner.authenticatedAt,
        linkGuarded: true,
      });
      const [legacy] = await environment.database
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, owner.userId));
      const canonical = await environment.database
        .select()
        .from(authAccount)
        .where(eq(authAccount.userId, owner.userId));
      const password = canonical.find((account) => account.providerId === 'credential');
      expect(password?.password).toBe(legacy.passwordHash);
      expect(await compare(' exact password bytes ', legacy.passwordHash)).toBe(true);
      expect(await compare('exact password bytes', legacy.passwordHash)).toBe(false);
      expect(canonical).toHaveLength(2);
      expect(canonical.every((account) => account.sourceGeneration === 1)).toBe(true);
      expect((await setWebPassword(environment.database, authority, command(owner))).outcome).toBe('unauthenticated');
      await switchTo('current-store');
      expect(
        (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)))[0]
          .passwordHash,
      ).toBe(legacy.passwordHash);
    });
  it('rolls back primary adapter write and generation when reverse legacy copy fails', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const owner = await fixture();
    await switchTo('better-auth');
    await environment.database.execute(
      sql`CREATE FUNCTION reject_password_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic mirror refusal'; END $$`,
    );
    await environment.database.execute(
      sql`CREATE TRIGGER reject_password_copy BEFORE INSERT ON user_credentials FOR EACH ROW EXECUTE FUNCTION reject_password_copy()`,
    );
    try {
      await expect(setWebPassword(environment.database, authority, command(owner))).rejects.toMatchObject({
        cause: { code: 'P0001', message: 'synthetic mirror refusal' },
      });
      expect(
        await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        (await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId))).every(
          (account) => account.providerId !== 'credential' && account.sourceGeneration === 0,
        ),
      ).toBe(true);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database
          .select()
          .from(authSecurityMutationEvents)
          .where(eq(authSecurityMutationEvents.userId, owner.userId)),
      ).toHaveLength(0);
    } finally {
      await environment.database.execute(sql`DROP TRIGGER reject_password_copy ON user_credentials`);
      await environment.database.execute(sql`DROP FUNCTION reject_password_copy()`);
    }
  });
  it('keeps reverse copy mandatory under canonical authority even when forward mirroring is off', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
    const owner = await fixture();
    await switchTo('better-auth');
    expect((await setWebPassword(environment.database, authority, command(owner))).outcome).toBe('set');
    const [legacy] = await environment.database
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, owner.userId));
    expect(typeof legacy?.passwordHash === 'string').toBe(true);
    expect(await compare(' exact password bytes ', legacy.passwordHash)).toBe(true);
  });
  it('rejects an authority switch after real bcrypt and then admits a new command on the current writer', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const owner = await fixture();
    await switchTo('better-auth');
    hashPhase.afterHash = async () => {
      await switchTo('current-store');
    };
    await expect(setWebPassword(environment.database, authority, command(owner))).rejects.toThrow('STALE_AUTHORITY');
    expect(
      await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      (await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId))).every(
        (account) => account.providerId !== 'credential',
      ),
    ).toBe(true);
    hashPhase.afterHash = undefined;
    expect((await setWebPassword(environment.database, authority, command(owner))).outcome).toBe('set');
  });
  it('rolls primary and successful cutoff/event SQL back on a semantic opaque-receipt refusal', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const owner = await fixture();
    await switchTo('better-auth');
    const actual = reverseIdentity.advanceCanonicalIdentityGeneration;
    let successfulWritesObserved = false;
    const observer = vi
      .spyOn(reverseIdentity, 'advanceCanonicalIdentityGeneration')
      .mockImplementation(async (transaction, userId) => {
        const canonical = await transaction.select().from(authAccount).where(eq(authAccount.userId, userId));
        const [cutoff] = await transaction
          .select()
          .from(authSubjectCutoffs)
          .where(eq(authSubjectCutoffs.userId, userId));
        const events = await transaction
          .select()
          .from(authSecurityMutationEvents)
          .where(eq(authSecurityMutationEvents.userId, userId));
        successfulWritesObserved =
          canonical.some((account) => account.providerId === 'credential' && typeof account.password === 'string') &&
          cutoff?.generation === 1 &&
          events.length === 1;
        await actual(transaction, userId, {} as IdentityGenerationMutationReceipt);
      });
    try {
      await expect(setWebPassword(environment.database, authority, command(owner))).rejects.toThrow(
        'MUTATION_RECEIPT_INVALID',
      );
      expect(successfulWritesObserved).toBe(true);
    } finally {
      observer.mockRestore();
    }
    expect(
      await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      (await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId))).every(
        (account) => account.providerId !== 'credential' && account.sourceGeneration === 0,
      ),
    ).toBe(true);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    ).toHaveLength(0);
  });

  it('rolls back a semantic reverse-provider ownership conflict after successful primary and legacy SQL', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    const owner = await fixture();
    await switchTo('better-auth');
    const otherId = randomUUID();
    await environment.database.insert(users).values({ id: otherId, email: `other-${otherId}@example.com` });
    await environment.database.update(accounts).set({ userId: otherId }).where(eq(accounts.userId, owner.userId));
    await expect(setWebPassword(environment.database, authority, command(owner))).rejects.toThrow(
      'PROVIDER_OWNER_CONFLICT',
    );
    expect(
      await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      (await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId))).every(
        (account) => account.providerId !== 'credential' && account.sourceGeneration === 0,
      ),
    ).toBe(true);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    ).toHaveLength(0);
    expect((await environment.database.select().from(accounts).where(eq(accounts.userId, otherId))).length).toBe(1);
  });
});
