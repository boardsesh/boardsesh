import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  emailVerificationTokenSchema,
  isReservedAuthRecordIdentifier,
  isVersionedEmailVerificationToken,
  LEGACY_EMAIL_VERIFICATION_LIFETIME_MS,
  legacyLinkAccount,
  type RegisterCommand,
  type RegisterReply,
  type ResendVerificationCommand,
  type ResendVerificationReply,
  type VerifyEmailCommand,
  type VerifyEmailReply,
} from '@boardsesh/auth-protocol';
import { normalizeAccountEmail, resolveAccountEmail } from '@boardsesh/auth-protocol/account-email';
import { authSubjectCutoffs, users, verificationTokens } from '@boardsesh/db/schema/auth';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { assertFresh, boundSignInLockWaits, claimCommand, transactionSettings } from './command-context';
import { CurrentStoreFoundationError, lockSubjectRow, type CurrentStoreTransaction } from './foundation-context';
import { prepareCurrentStorePasswordRegistration } from './password-identity';
import { webRegistrationSchema, registrationValidationMessage } from './web-password';
import {
  captureRegistrationContext,
  insertPreEnforcementPasswordIdentity,
  registrationEmailHolders,
  revalidateRegistrationContext,
  type RegistrationContext,
} from './registration-context';
import {
  consumeUidEmailVerification,
  issueUidEmailVerification,
  readUidEmailVerification,
  verificationClock,
} from './verification-receipts';
import { issuedBeforeRevocation } from './legacy-link-binding';

export interface RegistrationPolicy {
  readonly emailVerificationEnabled: boolean;
}

/** Gate, UID, cutoff, then purpose state and receipt; no session is created. */
export async function issuePreEnforcementVerification(
  transaction: CurrentStoreTransaction,
  context: RegistrationContext,
  userId: string,
) {
  await revalidateRegistrationContext(transaction, context);
  const user = await lockSubjectRow(transaction, userId);
  if (!user) return null;
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  return issueUidEmailVerification(transaction, user, cutoff);
}

export async function registerBeforeEnforcement(
  database: DbInstance,
  policyInput: RegistrationPolicy,
  input: RegisterCommand,
): Promise<RegisterReply> {
  const policy = { ...policyInput };
  const { requestId, issuedAt } = input;
  const parsed = webRegistrationSchema.safeParse(input.payload);
  const registration = parsed.success
    ? {
        ...parsed.data,
        email: normalizeAccountEmail(parsed.data.email),
        // Preserve the released web default display name's submitted case.
        name: parsed.data.name ?? parsed.data.email.split('@')[0],
      }
    : undefined;
  const invalidMessage = parsed.success ? undefined : registrationValidationMessage(parsed.error.issues[0].message);
  const context = await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    return captureRegistrationContext(transaction);
  });
  const prepared = registration ? await prepareCurrentStorePasswordRegistration(database, registration) : null;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'register', requestId } as const;
  return database.transaction(async (transaction): Promise<RegisterReply> => {
    await transactionSettings(transaction);
    await revalidateRegistrationContext(transaction, context);
    if (!(await claimCommand(transaction, { operation: 'register', requestId, issuedAt })))
      return { ...base, outcome: 'error', code: 'replayed' };
    assertFresh(issuedAt);
    if (!registration || invalidMessage)
      return { ...base, outcome: 'error', code: 'validation_error', message: invalidMessage! };
    const inserted = await insertPreEnforcementPasswordIdentity(
      transaction,
      context,
      registration.email,
      prepared,
      policy.emailVerificationEnabled,
    );
    if (inserted.outcome === 'exists') return { ...base, outcome: 'error', code: 'exists' };
    const { userId, createdAt } = inserted.identity;
    const created = { ...base, outcome: 'created', userId, createdAt: createdAt.toISOString() } as const;
    if (!policy.emailVerificationEnabled) {
      assertFresh(issuedAt);
      return { ...created, requiresVerification: false };
    }
    const mailPlan = await issuePreEnforcementVerification(transaction, context, userId);
    if (!mailPlan) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    await revalidateRegistrationContext(transaction, context);
    assertFresh(issuedAt);
    return { ...created, requiresVerification: true, mailPlan };
  });
}

const resendSchema = z.object({ email: z.string().email('Invalid email address') });

export async function resendBeforeEnforcement(
  database: DbInstance,
  input: ResendVerificationCommand,
): Promise<ResendVerificationReply> {
  const { requestId, issuedAt } = input;
  const parsed = resendSchema.safeParse(input.payload);
  const email = parsed.success ? parsed.data.email : undefined;
  const message = parsed.success ? undefined : registrationValidationMessage(parsed.error.issues[0].message);
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'resend-verification', requestId } as const;
  return database.transaction(async (transaction): Promise<ResendVerificationReply> => {
    await transactionSettings(transaction);
    const context = await captureRegistrationContext(transaction);
    if (!(await claimCommand(transaction, { operation: 'resend-verification', requestId, issuedAt })))
      return { ...base, outcome: 'error', code: 'replayed' };
    assertFresh(issuedAt);
    if (!email || message) return { ...base, outcome: 'error', code: 'validation_error', message: message! };
    const key = normalizeAccountEmail(email);
    const holders = await registrationEmailHolders(transaction, key);
    // The released default resend works for an unverified account even while
    // registration verification is disabled. Do not turn that into a no-op.
    const hint = holders.length === 1 ? holders[0] : undefined;
    if (!hint || hint.emailVerified) return { ...base, outcome: 'accepted' };
    await boundSignInLockWaits(transaction);
    const user = await lockSubjectRow(transaction, hint.id);
    const current = await registrationEmailHolders(transaction, key);
    if (!user || normalizeAccountEmail(user.email) !== key || current.length !== 1 || current[0].id !== hint.id)
      return { ...base, outcome: 'accepted' };
    const mailPlan = await issuePreEnforcementVerification(transaction, context, user.id);
    await revalidateRegistrationContext(transaction, context);
    assertFresh(issuedAt);
    return { ...base, outcome: 'accepted', ...(mailPlan ? { mailPlan } : {}) };
  });
}

async function verifyCurrentStoreUser(transaction: CurrentStoreTransaction, userId: string, verifiedAt: Date) {
  await transaction
    .update(users)
    .set({ emailVerified: verifiedAt })
    .where(and(eq(users.id, userId), isNull(users.emailVerified)));
}

/**
 * Preserve the old public UUID verifier without claiming historical provenance.
 * It is not the staged legacy importer. No deadline or owner evidence is added.
 * Recheck under UID/token locks and delete conditionally so participating
 * consumers cannot redeem one row twice; unfenced old replicas remain a gate.
 */
async function consumeLegacyCompatibility(
  transaction: CurrentStoreTransaction,
  token: string,
  email: string,
): Promise<'verified' | 'invalid_token' | 'expired'> {
  const predicate = and(eq(verificationTokens.identifier, email), eq(verificationTokens.token, token));
  const [initial] = await transaction.select().from(verificationTokens).where(predicate);
  if (!initial) return 'invalid_token';
  const key = normalizeAccountEmail(email);
  const holders = await registrationEmailHolders(transaction, key);
  const account = legacyLinkAccount(resolveAccountEmail(email, holders), {
    expires: initial.expires,
    lifetimeMs: LEGACY_EMAIL_VERIFICATION_LIFETIME_MS,
  });
  const user = account ? await lockSubjectRow(transaction, account.id) : undefined;
  const [cutoff] = user
    ? await transaction.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, user.id)).for('update')
    : [];
  const [locked] = await transaction.select().from(verificationTokens).where(predicate).for('update');
  if (!locked || locked.expires.getTime() !== initial.expires.getTime()) return 'invalid_token';
  const now = new Date(await verificationClock(transaction));
  if (locked.expires.getTime() <= now.getTime()) {
    await transaction.delete(verificationTokens).where(predicate);
    return 'expired';
  }
  const current = await registrationEmailHolders(transaction, key);
  const bound = legacyLinkAccount(resolveAccountEmail(email, current), {
    expires: locked.expires,
    lifetimeMs: LEGACY_EMAIL_VERIFICATION_LIFETIME_MS,
  });
  if (current.length === 0) {
    await transaction.delete(verificationTokens).where(predicate);
    return 'invalid_token';
  }
  if (!user || user.email !== email || bound?.id !== user.id || cutoff?.deletedAt) return 'invalid_token';
  if (issuedBeforeRevocation(locked.expires, LEGACY_EMAIL_VERIFICATION_LIFETIME_MS, cutoff)) return 'invalid_token';
  const consumed = await transaction
    .delete(verificationTokens)
    .where(predicate)
    .returning({ token: verificationTokens.token });
  if (consumed.length !== 1) return 'invalid_token';
  await verifyCurrentStoreUser(transaction, user.id, now);
  return 'verified';
}

export async function verifyBeforeEnforcement(
  database: DbInstance,
  input: VerifyEmailCommand,
): Promise<VerifyEmailReply> {
  const { requestId, issuedAt } = input;
  const { token, email } = input.payload;
  const supported = emailVerificationTokenSchema.safeParse(token).success;
  const initial = supported ? await readUidEmailVerification(database, token) : undefined;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'verify-email', requestId } as const;
  return database.transaction(async (transaction): Promise<VerifyEmailReply> => {
    await transactionSettings(transaction);
    const context = await captureRegistrationContext(transaction);
    if (!(await claimCommand(transaction, { operation: 'verify-email', requestId, issuedAt })))
      return { ...base, outcome: 'error', code: 'replayed' };
    assertFresh(issuedAt);
    let outcome: 'verified' | 'invalid_token' | 'expired';
    if (supported) {
      if (!initial) return { ...base, outcome: 'invalid_token' };
      const user = await lockSubjectRow(transaction, initial.userId);
      const [cutoff] = await transaction
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, initial.userId))
        .for('update');
      outcome = await consumeUidEmailVerification(transaction, initial, user, cutoff, issuedAt, (verifiedAt) =>
        verifyCurrentStoreUser(transaction, initial.userId, verifiedAt),
      );
    } else if (isVersionedEmailVerificationToken(token)) {
      return /^ev1_/i.test(token)
        ? { ...base, outcome: 'invalid_token' }
        : { ...base, outcome: 'error', code: 'unavailable' };
    } else if (!email || isReservedAuthRecordIdentifier(email)) {
      return { ...base, outcome: 'invalid_token' };
    } else {
      outcome = await consumeLegacyCompatibility(transaction, token, email);
    }
    await revalidateRegistrationContext(transaction, context);
    assertFresh(issuedAt);
    return { ...base, outcome };
  });
}
