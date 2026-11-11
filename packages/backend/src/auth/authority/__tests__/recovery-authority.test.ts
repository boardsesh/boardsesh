import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, type ResetPasswordCommand } from '@boardsesh/auth-protocol';
import {
  users,
  accounts,
  authAccount,
  userCredentials,
  mobileRefreshTokens,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  authPasswordRecoveryTokens,
  authEmailProjection,
  verificationTokens,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { requestPasswordRecovery, consumePasswordRecovery } from '../../current-store/password-recovery';
import { syncIdentity } from '../sync-identity';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  expectedWriterEpoch: 1,
  emailVerificationEnabled: false,
};
const digest = (token: string) => createHash('sha256').update(`password-recovery-v1\0${token}`).digest('hex');
async function fixture() {
  const userId = randomUUID();
  const email = `reset-${userId}@example.com`;
  const originalHash = await bcrypt.hash(' original password ', 4);
  await environment.database.insert(users).values({ id: userId, email, name: null, emailVerified: null });
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    await reserveEnforcedEmail(transaction, {
      ...authority,
      expectedWriterEpoch: manifest.writerEpoch,
      rawEmail: email,
      requestedUserId: userId,
    });
    await transaction.insert(userCredentials).values({ userId, passwordHash: originalHash });
    await syncIdentity(transaction, userId, 'current-store-to-authority');
    await transaction.insert(mobileRefreshTokens).values({
      userId,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
      sessionId: randomUUID(),
      subjectGeneration: 0,
      nativeGeneration: 0,
    });
  });
  return { userId, email, originalHash };
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
async function issue(email: string) {
  const reply = await requestPasswordRecovery(environment.database, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'forgot-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email },
  });
  if (reply.outcome !== 'accepted' || !reply.mailPlan) throw new Error('Missing owned recovery fixture');
  return reply.mailPlan.token;
}
function reset(token: string, email?: string): ResetPasswordCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'reset-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token, email, password: ' replacement password ', confirmPassword: ' replacement password ' },
  };
}
async function assertReset(owner: Awaited<ReturnType<typeof fixture>>) {
  const [legacy] = await environment.database
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, owner.userId));
  const [canonical] = await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId));
  expect(canonical.password).toBe(legacy.passwordHash);
  expect(canonical.sourceGeneration).toBe(1);
  expect(await bcrypt.compare(' replacement password ', legacy.passwordHash)).toBe(true);
  expect(await bcrypt.compare('replacement password', legacy.passwordHash)).toBe(false);
  const [cutoff] = await environment.database
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, owner.userId));
  expect(cutoff.generation).toBe(1);
  expect(
    (
      await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, owner.userId))
    ).every((refresh) => refresh.revokedAt !== null),
  ).toBe(true);
}
describe('selected authority recovery writers', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.database.execute(sql`CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))`);
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-recovery-retired-mailbox-key-6975');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await switchTo('current-store');
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const)
    for (const format of ['versioned', 'bound-legacy'] as const)
      it(`${selected} resets ${format} once, preserving exact mirror and revocation intent`, async () => {
        const owner = await fixture();
        let token: string;
        if (format === 'versioned') token = await issue(owner.email);
        else {
          token = randomUUID();
          await environment.database.insert(verificationTokens).values({
            identifier: `password-reset:${owner.email}`,
            token: createHash('sha256').update(token).digest('hex'),
            expires: new Date(Date.now() + 3599000),
          });
        }
        await switchTo(selected);
        if (selected === 'better-auth') vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
        expect(
          (await consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).outcome,
        ).toBe('reset');
        await assertReset(owner);
        expect(
          (await consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).outcome,
        ).toBe('invalid_or_expired');
      });
  it('requests recovery from canonical presence even when the legacy credential copy is absent', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    await environment.database.delete(userCredentials).where(eq(userCredentials.userId, owner.userId));
    expect(await issue(owner.email)).toMatch(/^pr1_/);
  });
  it('refuses a switch after actual bcrypt without consuming the UID receipt', async () => {
    const owner = await fixture();
    const token = await issue(owner.email);
    const actualHash = bcrypt.hash.bind(bcrypt);
    vi.spyOn(bcrypt, 'hash').mockImplementationOnce(async (password, salt) => {
      const hashed = await actualHash(password, salt);
      await switchTo('better-auth');
      return hashed;
    });
    await expect(consumePasswordRecovery(environment.database, authority, reset(token))).rejects.toMatchObject({
      code: 'STALE_AUTHORITY',
    });
    const [receipt] = await environment.database
      .select()
      .from(authPasswordRecoveryTokens)
      .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
    expect(receipt.consumedAt).toBeNull();
    expect((await consumePasswordRecovery(environment.database, authority, reset(token))).outcome).toBe('reset');
    await assertReset(owner);
  });
  for (const format of ['versioned', 'bound-legacy'] as const)
    it(`refuses primary hash drift after real bcrypt for ${format}, leaving the link usable`, async () => {
      const owner = await fixture();
      const token = format === 'versioned' ? await issue(owner.email) : randomUUID();
      if (format === 'bound-legacy')
        await environment.database.insert(verificationTokens).values({
          identifier: `password-reset:${owner.email}`,
          token: createHash('sha256').update(token).digest('hex'),
          expires: new Date(Date.now() + 3599000),
        });
      const changedHash = await bcrypt.hash(' intervening password ', 4);
      await switchTo('better-auth');
      const actualHash = bcrypt.hash.bind(bcrypt);
      vi.spyOn(bcrypt, 'hash').mockImplementationOnce(async (password, salt) => {
        const hashed = await actualHash(password, salt);
        await environment.database
          .update(authAccount)
          .set({ password: changedHash })
          .where(eq(authAccount.userId, owner.userId));
        return hashed;
      });
      expect((await consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).outcome).toBe(
        'invalid_or_expired',
      );
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      const [canonical] = await environment.database
        .select()
        .from(authAccount)
        .where(eq(authAccount.userId, owner.userId));
      expect(canonical.password).toBe(changedHash);
      expect(canonical.sourceGeneration).toBe(0);
      // A fresh command proves the rejection did not consume either link format.
      expect((await consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).outcome).toBe(
        'reset',
      );
      await assertReset(owner);
    });
  it('refuses UID token binding drift after real bcrypt without replacing the credential', async () => {
    const owner = await fixture();
    const token = await issue(owner.email);
    await switchTo('better-auth');
    const actualHash = bcrypt.hash.bind(bcrypt);
    vi.spyOn(bcrypt, 'hash').mockImplementationOnce(async (password, salt) => {
      const hashed = await actualHash(password, salt);
      await environment.database
        .update(authPasswordRecoveryTokens)
        .set({ issuanceGeneration: 100 })
        .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
      return hashed;
    });
    expect((await consumePasswordRecovery(environment.database, authority, reset(token))).outcome).toBe(
      'invalid_or_expired',
    );
    const [receipt] = await environment.database
      .select()
      .from(authPasswordRecoveryTokens)
      .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
    expect(receipt.consumedAt).toBeNull();
    const [canonical] = await environment.database
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, owner.userId));
    expect(canonical.password).toBe(owner.originalHash);
    expect(canonical.sourceGeneration).toBe(0);
  });
  it('rolls back receipt consumption, adapter replacement and cutoff on failed reverse copy', async () => {
    const owner = await fixture();
    const token = await issue(owner.email);
    await switchTo('better-auth');
    await environment.database.execute(
      sql`CREATE FUNCTION reject_recovery_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic recovery mirror refusal'; END $$`,
    );
    await environment.database.execute(
      sql`CREATE TRIGGER reject_recovery_copy BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION reject_recovery_copy()`,
    );
    try {
      await expect(consumePasswordRecovery(environment.database, authority, reset(token))).rejects.toMatchObject({
        cause: { code: 'P0001', message: 'synthetic recovery mirror refusal' },
      });
      const [receipt] = await environment.database
        .select()
        .from(authPasswordRecoveryTokens)
        .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
      expect(receipt.consumedAt).toBeNull();
      const [canonical] = await environment.database
        .select()
        .from(authAccount)
        .where(eq(authAccount.userId, owner.userId));
      expect(canonical.password).toBe(owner.originalHash);
      expect(canonical.sourceGeneration).toBe(0);
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
      await environment.database.execute(sql`DROP TRIGGER reject_recovery_copy ON user_credentials`);
      await environment.database.execute(sql`DROP FUNCTION reject_recovery_copy()`);
    }
  });
  it('does not issue from a legacy-only credential when the selected canonical password is absent', async () => {
    const owner = await fixture();
    await switchTo('better-auth');
    await environment.database.delete(authAccount).where(eq(authAccount.userId, owner.userId));
    const reply = await requestPasswordRecovery(environment.database, authority, {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'forgot-password',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { email: owner.email },
    });
    expect(reply.outcome).toBe('accepted');
    expect('mailPlan' in reply && reply.mailPlan).toBeFalsy();
  });
  for (const format of ['versioned', 'bound-legacy'] as const) {
    it(`refuses generation-only canonical drift after actual bcrypt for ${format} then admits a fresh retry`, async () => {
      const owner = await fixture();
      const token = format === 'versioned' ? await issue(owner.email) : randomUUID();
      if (format === 'bound-legacy')
        await environment.database.insert(verificationTokens).values({
          identifier: `password-reset:${owner.email}`,
          token: createHash('sha256').update(token).digest('hex'),
          expires: new Date(Date.now() + 3599000),
        });
      await switchTo('better-auth');
      const actualHash = bcrypt.hash.bind(bcrypt);
      vi.spyOn(bcrypt, 'hash').mockImplementationOnce(async (password, salt) => {
        const hashed = await actualHash(password, salt);
        await environment.database
          .update(authAccount)
          .set({ sourceGeneration: 1 })
          .where(eq(authAccount.userId, owner.userId));
        return hashed;
      });
      expect((await consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).outcome).toBe(
        'invalid_or_expired',
      );
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      const [canonical] = await environment.database
        .select()
        .from(authAccount)
        .where(eq(authAccount.userId, owner.userId));
      expect(canonical.password).toBe(owner.originalHash);
      await environment.database
        .update(authAccount)
        .set({ sourceGeneration: 0 })
        .where(eq(authAccount.userId, owner.userId));
      expect((await consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).outcome).toBe(
        'reset',
      );
      await assertReset(owner);
    });
    it(`rolls back successful reset SQL on semantic reverse-owner conflict for ${format}`, async () => {
      const owner = await fixture();
      const other = await fixture();
      const token = format === 'versioned' ? await issue(owner.email) : randomUUID();
      if (format === 'bound-legacy')
        await environment.database.insert(verificationTokens).values({
          identifier: `password-reset:${owner.email}`,
          token: createHash('sha256').update(token).digest('hex'),
          expires: new Date(Date.now() + 3599000),
        });
      const providerSubject = randomUUID();
      await environment.database
        .insert(accounts)
        .values({ userId: other.userId, type: 'oauth', provider: 'google', providerAccountId: providerSubject });
      await environment.database.insert(authAccount).values({
        id: randomUUID(),
        userId: owner.userId,
        providerId: 'google',
        accountId: providerSubject,
        sourceGeneration: 0,
      });
      await switchTo('better-auth');
      await expect(consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).rejects.toThrow(
        'AUTH_IDENTITY_PROVIDER_OWNER_CONFLICT',
      );
      const canonical = await environment.database
        .select()
        .from(authAccount)
        .where(eq(authAccount.userId, owner.userId));
      expect(canonical.find((account) => account.providerId === 'credential')?.password).toBe(owner.originalHash);
      expect(canonical.every((account) => account.sourceGeneration === 0)).toBe(true);
      const [legacy] = await environment.database
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, owner.userId));
      expect(legacy.passwordHash).toBe(owner.originalHash);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database
          .select()
          .from(authSecurityMutationEvents)
          .where(eq(authSecurityMutationEvents.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        (
          await environment.database
            .select()
            .from(mobileRefreshTokens)
            .where(eq(mobileRefreshTokens.userId, owner.userId))
        ).every((refresh) => refresh.revokedAt === null),
      ).toBe(true);
      // Remove only the synthetic conflict, then require real success using the SAME link.
      await environment.database.delete(accounts).where(eq(accounts.providerAccountId, providerSubject));
      expect((await consumePasswordRecovery(environment.database, authority, reset(token, owner.email))).outcome).toBe(
        'reset',
      );
      const [password] = await environment.database
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, owner.userId));
      expect(await bcrypt.compare(' replacement password ', password.passwordHash)).toBe(true);
    });
  }

  it('rejects a UID owner change in the token after actual bcrypt and preserves both subjects', async () => {
    const owner = await fixture();
    const other = await fixture();
    const token = await issue(owner.email);
    await issue(other.email);
    await environment.database
      .delete(authPasswordRecoveryTokens)
      .where(eq(authPasswordRecoveryTokens.userId, other.userId));
    await switchTo('better-auth');
    const actualHash = bcrypt.hash.bind(bcrypt);
    vi.spyOn(bcrypt, 'hash').mockImplementationOnce(async (password, salt) => {
      const hashed = await actualHash(password, salt);
      await environment.database
        .update(authPasswordRecoveryTokens)
        .set({ userId: other.userId })
        .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
      return hashed;
    });
    expect((await consumePasswordRecovery(environment.database, authority, reset(token))).outcome).toBe(
      'invalid_or_expired',
    );
    for (const subject of [owner, other]) {
      const [canonical] = await environment.database
        .select()
        .from(authAccount)
        .where(eq(authAccount.userId, subject.userId));
      expect(canonical.password).toBe(subject.originalHash);
      expect(canonical.sourceGeneration).toBe(0);
      expect(
        await environment.database
          .select()
          .from(authSubjectCutoffs)
          .where(eq(authSubjectCutoffs.userId, subject.userId)),
      ).toHaveLength(0);
    }
    const [receipt] = await environment.database
      .select()
      .from(authPasswordRecoveryTokens)
      .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
    expect(receipt.consumedAt).toBeNull();
    await environment.database
      .update(authPasswordRecoveryTokens)
      .set({ userId: owner.userId })
      .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
    expect((await consumePasswordRecovery(environment.database, authority, reset(token))).outcome).toBe('reset');
    await assertReset(owner);
  });
});
