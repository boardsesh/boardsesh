import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, type VerifyEmailCommand } from '@boardsesh/auth-protocol';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authSecurityMutationEvents,
  authSession,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { consumeEmailVerification, resendEmailVerification } from '../../current-store/email-verification';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { syncIdentity } from '../sync-identity';
import * as reverseIdentity from '../reverse-identity';
import * as forwardIdentity from '../sync-identity';
import * as authorityRouter from '../router';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  // Deliberately unchanged while actual manifest epochs advance.
  expectedWriterEpoch: 1,
  emailVerificationEnabled: true,
};
const digest = (token: string) => createHash('sha256').update(`email-verification-v1\0${token}`).digest('hex');

async function selectAuthority(to: IdentityAuthorityName) {
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
async function fixture() {
  const userId = randomUUID();
  const email = `verification-${userId}@example.test`;
  const passwordHash = `synthetic-preserved-bcrypt-${userId}`;
  const providerSubject = randomUUID();
  await environment.database.insert(users).values({ id: userId, email, emailVerified: null });
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    await reserveEnforcedEmail(transaction, {
      ...authority,
      expectedWriterEpoch: manifest.writerEpoch,
      rawEmail: email,
      requestedUserId: userId,
    });
    await transaction.insert(userCredentials).values({ userId, passwordHash });
    await transaction
      .insert(accounts)
      .values({ userId, provider: 'google', providerAccountId: providerSubject, type: 'oauth' });
    await syncIdentity(transaction, userId, 'current-store-to-authority');
  });
  return { userId, email, passwordHash, providerSubject };
}
async function resend(email: string) {
  return resendEmailVerification(environment.database, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'resend-verification',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email },
  });
}
async function issue(email: string) {
  const reply = await resend(email);
  if (reply.outcome !== 'accepted' || !reply.mailPlan) throw new Error('Owned verification receipt missing');
  return reply.mailPlan;
}
function command(token: string, email?: string): VerifyEmailCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'verify-email',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token, ...(email === undefined ? {} : { email }) },
  };
}
async function consume(token: string, email?: string) {
  return consumeEmailVerification(environment.database, authority, command(token, email));
}
async function tokenRow(token: string) {
  const [receipt] = await environment.database
    .select()
    .from(authEmailVerificationTokens)
    .where(eq(authEmailVerificationTokens.tokenHash, digest(token)));
  return receipt;
}
async function verificationState(userId: string) {
  const [state] = await environment.database
    .select()
    .from(authEmailVerificationState)
    .where(eq(authEmailVerificationState.userId, userId));
  return state;
}
async function verifiedAt(userId: string) {
  const [user] = await environment.database.select().from(users).where(eq(users.id, userId));
  return user.emailVerified;
}
async function assertIdentityUnchanged(owner: Awaited<ReturnType<typeof fixture>>) {
  const [password] = await environment.database
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, owner.userId));
  expect(password.passwordHash).toBe(owner.passwordHash);
  expect(await environment.database.select().from(authAccount).where(eq(authAccount.userId, owner.userId))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        providerId: 'credential',
        accountId: owner.userId,
        password: owner.passwordHash,
        sourceGeneration: 0,
      }),
      expect.objectContaining({ providerId: 'google', accountId: owner.providerSubject, sourceGeneration: 0 }),
    ]),
  );
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
    await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId)),
  ).toHaveLength(0);
  expect(
    await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, owner.userId)),
  ).toHaveLength(0);
}

describe('selected authority verification and resend', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.database.execute(sql`CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))`);
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-verification-retired-mailbox-key-6975');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await selectAuthority('current-store');
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const) {
    for (const mirror of ['on', 'off'] as const)
      it(`${selected}, mirror ${mirror}: verifies UID receipts once with original clock, identity and generations`, async () => {
        const owner = await fixture();
        await selectAuthority(selected);
        vi.stubEnv('AUTH_IDENTITY_MIRROR', mirror);
        if (selected === 'better-auth') {
          await environment.database.delete(userCredentials).where(eq(userCredentials.userId, owner.userId));
          await environment.database.delete(accounts).where(eq(accounts.userId, owner.userId));
        }
        const mail = await issue(owner.email.toUpperCase());
        const original = await tokenRow(mail.token);
        expect(original).toMatchObject({
          userId: owner.userId,
          purpose: 'email-verification',
          normalizedEmail: owner.email,
          deliveredEmail: owner.email,
          subjectGeneration: 0,
          issuanceGeneration: 1,
        });
        expect(original.expiresAt.getTime() - original.issuedAt.getTime()).toBe(24 * 3600000);
        expect(new Date(mail.expiresAt)).toEqual(original.expiresAt);
        expect((await consume(mail.token, 'untrusted-other-address@example.test')).outcome).toBe('verified');
        const consumed = await tokenRow(mail.token);
        expect(consumed.expiresAt).toEqual(original.expiresAt);
        expect(consumed.issuedAt).toEqual(original.issuedAt);
        expect(await verifiedAt(owner.userId)).toEqual(consumed.consumedAt);
        expect((await verificationState(owner.userId)).generation).toBe(2);
        expect((await consume(mail.token)).outcome).toBe('invalid_token');
        await assertIdentityUnchanged(owner);
      });

    it(`${selected}: preserves legacy link bytes/deadline and existing verification timestamp`, async () => {
      const owner = await fixture();
      const token = randomUUID();
      const expires = new Date(Date.now() + 23 * 3600000);
      await environment.database.insert(verificationTokens).values({ identifier: owner.email, token, expires });
      await selectAuthority(selected);
      const originalTimestamp = new Date('2026-10-04T13:14:15.123Z');
      await environment.database
        .update(users)
        .set({ emailVerified: originalTimestamp })
        .where(eq(users.id, owner.userId));
      expect((await consume(token, owner.email)).outcome).toBe('verified');
      expect(await verifiedAt(owner.userId)).toEqual(originalTimestamp);
      expect((await consume(token, owner.email)).outcome).toBe('invalid_token');
      expect(
        await environment.database.select().from(verificationTokens).where(eq(verificationTokens.token, token)),
      ).toEqual([{ identifier: owner.email, token, expires }]);
      await assertIdentityUnchanged(owner);
    });

    it(`${selected}: only the newest resend remains usable, and expiry never becomes fresh issuance`, async () => {
      const owner = await fixture();
      await selectAuthority(selected);
      const first = await issue(owner.email);
      const next = await issue(owner.email);
      expect((await tokenRow(first.token)).supersededAt).not.toBeNull();
      expect((await consume(first.token)).outcome).toBe('invalid_token');
      const deadline = new Date(Date.now() - 1000);
      await environment.database
        .update(authEmailVerificationTokens)
        .set({ issuedAt: new Date(deadline.getTime() - 24 * 3600000), expiresAt: deadline })
        .where(eq(authEmailVerificationTokens.tokenHash, digest(next.token)));
      expect((await consume(next.token)).outcome).toBe('expired');
      expect(await verifiedAt(owner.userId)).toBeNull();
      expect((await tokenRow(next.token)).consumedAt).toBeNull();
      expect((await tokenRow(next.token)).expiresAt).toEqual(deadline);
    });

    it(`${selected}: concurrent receipt redemption admits one owner exactly once`, async () => {
      const owner = await fixture();
      await selectAuthority(selected);
      const mail = await issue(owner.email);
      const results = await Promise.all([consume(mail.token), consume(mail.token)]);
      expect(results.map((reply) => reply.outcome).sort()).toEqual(['invalid_token', 'verified']);
      expect((await verificationState(owner.userId)).generation).toBe(2);
      expect(await verifiedAt(owner.userId)).toEqual((await tokenRow(mail.token)).consumedAt);
    });

    for (const drift of ['address', 'purpose', 'generation'] as const)
      it(`${selected}: refuses ${drift} drift without consuming the token`, async () => {
        const owner = await fixture();
        await selectAuthority(selected);
        const mail = await issue(owner.email);
        if (drift === 'address')
          await environment.database
            .update(users)
            .set({ email: `changed-${owner.email}` })
            .where(eq(users.id, owner.userId));
        else if (drift === 'generation')
          await environment.database
            .update(authEmailVerificationTokens)
            .set({ subjectGeneration: 1 })
            .where(eq(authEmailVerificationTokens.tokenHash, digest(mail.token)));
        const presented = drift === 'purpose' ? mail.token.replace(/^ev1_/, 'pr1_') : mail.token;
        expect((await consume(presented)).outcome).toBe('invalid_token');
        expect((await tokenRow(mail.token)).consumedAt).toBeNull();
        expect(await verifiedAt(owner.userId)).toBeNull();
      });

    it(`${selected}: rolls back verification, receipt, terminal generation and command claim when mirror fails`, async () => {
      const owner = await fixture();
      await selectAuthority(selected);
      const mail = await issue(owner.email);
      const request = command(mail.token);
      const initialCommands = await environment.database.select().from(verificationTokens);
      const failingMirror =
        selected === 'better-auth'
          ? vi.spyOn(reverseIdentity, 'mirrorAuthorityToCurrentStore')
          : vi.spyOn(forwardIdentity, 'mirrorIdentityIfEnabled');
      failingMirror.mockRejectedValueOnce(new Error('Synthetic verification mirror refusal'));
      await expect(consumeEmailVerification(environment.database, authority, request)).rejects.toThrow(
        'Synthetic verification mirror refusal',
      );
      expect(await verifiedAt(owner.userId)).toBeNull();
      expect((await tokenRow(mail.token)).consumedAt).toBeNull();
      expect((await verificationState(owner.userId)).generation).toBe(1);
      expect(await environment.database.select().from(verificationTokens)).toEqual(initialCommands);
      expect((await consumeEmailVerification(environment.database, authority, request)).outcome).toBe('verified');
    });

    for (const operation of ['resend', 'consume'] as const)
      it(`${selected}: rejects an authority switch after selection before ${operation} can commit`, async () => {
        const owner = await fixture();
        await selectAuthority(selected);
        const mail = await issue(owner.email);
        const originalCapture = authorityRouter.captureIdentityAuthority;
        vi.spyOn(authorityRouter, 'captureIdentityAuthority').mockImplementationOnce(
          async (transaction, qualification) => {
            const receipt = await originalCapture(transaction, qualification);
            await switchIdentityAuthority(transaction, {
              projectionId,
              epoch: receipt.epoch,
              from: selected,
              to: selected === 'current-store' ? 'better-auth' : 'current-store',
            });
            return receipt;
          },
        );
        await expect(operation === 'resend' ? resend(owner.email) : consume(mail.token)).rejects.toMatchObject({
          code: 'STALE_AUTHORITY',
        });
        expect(await verifiedAt(owner.userId)).toBeNull();
        expect((await tokenRow(mail.token)).consumedAt).toBeNull();
        expect((await verificationState(owner.userId)).generation).toBe(1);
        expect((await consume(mail.token)).outcome).toBe('verified');
      });
  }
});
