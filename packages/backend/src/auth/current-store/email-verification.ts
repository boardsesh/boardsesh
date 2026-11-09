import { createHash, randomBytes } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  emailVerificationTokenSchema,
  isReservedAuthRecordIdentifier,
  isVersionedEmailVerificationToken,
  type RegistrationMailPlan,
  type ResendVerificationCommand,
  type ResendVerificationReply,
  type VerifyEmailCommand,
  type VerifyEmailReply,
} from '@boardsesh/auth-protocol';
import {
  authEmailReservationMembers,
  authEmailReservations,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authSubjectCutoffs,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeAccountEmail } from '../normalize-email';
import {
  assertFresh,
  captureAuthority,
  claimCommand,
  transactionSettings,
  type WebPasswordAuthority,
} from './command-context';
import { lockEnforcedProjection, lockUserRowUnderManifest, type CurrentStoreTransaction } from './foundation-context';

const purpose = 'email-verification' as const;
const lifetimeMs = 24 * 60 * 60 * 1000;
const resendSchema = z.object({ email: z.string().email('Invalid email address') });
const tokenHash = (token: string) => createHash('sha256').update(`email-verification-v1\0${token}`).digest('hex');

async function clock(transaction: CurrentStoreTransaction): Promise<number> {
  const instant = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  const milliseconds = Number(instant?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Verification clock unavailable');
  return milliseconds;
}

async function reservationOwner(transaction: CurrentStoreTransaction, authority: WebPasswordAuthority, key: string) {
  const [reservation] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, key))
    .for('update');
  if (
    !reservation ||
    reservation.basisProjectionId !== authority.expectedProjectionId ||
    reservation.state !== 'owned' ||
    !reservation.ownerUserId
  )
    return null;
  const members = await transaction
    .select()
    .from(authEmailReservationMembers)
    .where(eq(authEmailReservationMembers.normalizedEmail, key))
    .limit(2)
    .for('update');
  return members.length === 1 && members[0].userId === reservation.ownerUserId ? reservation.ownerUserId : null;
}

/** Caller already owns the manifest gate; IDs come only from registration or a proven reservation. */
export async function issueEmailVerification(
  transaction: CurrentStoreTransaction,
  authorityInput: WebPasswordAuthority,
  userIdInput: string,
): Promise<RegistrationMailPlan | null> {
  const authority = captureAuthority(authorityInput);
  const userId = userIdInput;
  await lockEnforcedProjection(transaction, authority);
  const [initial] = await transaction.select().from(users).where(eq(users.id, userId));
  if (!initial) return null;
  const key = normalizeAccountEmail(initial.email);
  if ((await reservationOwner(transaction, authority, key)) !== userId) return null;
  const user = await lockUserRowUnderManifest(transaction, userId);
  if (!user || user.emailVerified || normalizeAccountEmail(user.email) !== key) return null;
  const recipient = user.email.trim();
  if (!z.email().safeParse(recipient).success) return null;
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  if (cutoff?.deletedAt) return null;
  await transaction.insert(authEmailVerificationState).values({ userId, purpose, generation: 0 }).onConflictDoNothing();
  const [state] = await transaction
    .select()
    .from(authEmailVerificationState)
    .where(and(eq(authEmailVerificationState.userId, userId), eq(authEmailVerificationState.purpose, purpose)))
    .for('update');
  if (!state) throw new Error('Verification state unavailable');
  // One DB clock value defines BOTH original issuance and original expiry.
  const issuedAt = new Date(await clock(transaction));
  const expiresAt = new Date(issuedAt.getTime() + lifetimeMs);
  const [next] = await transaction
    .update(authEmailVerificationState)
    .set({ generation: sql`${authEmailVerificationState.generation} + 1`, updatedAt: issuedAt })
    .where(and(eq(authEmailVerificationState.userId, userId), eq(authEmailVerificationState.purpose, purpose)))
    .returning();
  if (!next) throw new Error('Verification generation unavailable');
  // Includes expired active rows; volatile time never appears in the index.
  await transaction
    .update(authEmailVerificationTokens)
    .set({ supersededAt: issuedAt })
    .where(
      and(
        eq(authEmailVerificationTokens.userId, userId),
        eq(authEmailVerificationTokens.purpose, purpose),
        isNull(authEmailVerificationTokens.consumedAt),
        isNull(authEmailVerificationTokens.supersededAt),
      ),
    );
  const token = `ev1_${randomBytes(32).toString('base64url')}`;
  await transaction.insert(authEmailVerificationTokens).values({
    tokenHash: tokenHash(token),
    userId,
    purpose,
    deliveredEmail: recipient,
    normalizedEmail: key,
    subjectGeneration: cutoff?.generation ?? 0,
    issuanceGeneration: next.generation,
    issuedAt,
    expiresAt,
  });
  return { kind: 'uid-email-verification-v1', recipient, token, expiresAt: expiresAt.toISOString() };
}

export async function resendEmailVerification(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: ResendVerificationCommand,
): Promise<ResendVerificationReply> {
  const authority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const parsed = resendSchema.safeParse(input.payload);
  const email = parsed.success ? parsed.data.email : undefined;
  // Validation text is generated only by this fixed schema, never reflection.
  const message = parsed.success ? undefined : parsed.error.issues[0].message;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'resend-verification', requestId } as const;
  return database.transaction(async (transaction): Promise<ResendVerificationReply> => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
    const claimed = await claimCommand(transaction, { operation: 'resend-verification', requestId, issuedAt });
    assertFresh(issuedAt);
    if (!claimed) return { ...base, outcome: 'error', code: 'replayed' };
    if (!email || message)
      return {
        ...base,
        outcome: 'error',
        code: 'validation_error',
        message: message as Extract<ResendVerificationReply, { code: 'validation_error' }>['message'],
      };
    if (!authority.emailVerificationEnabled) return { ...base, outcome: 'accepted' };
    const owner = await reservationOwner(transaction, authority, normalizeAccountEmail(email));
    const mailPlan = owner ? await issueEmailVerification(transaction, authority, owner) : null;
    assertFresh(issuedAt);
    return { ...base, outcome: 'accepted', ...(mailPlan ? { mailPlan } : {}) };
  });
}

type Receipt = typeof authEmailVerificationTokens.$inferSelect;
function sameBinding(first: Receipt, locked: Receipt) {
  return (
    first.tokenHash === locked.tokenHash &&
    first.userId === locked.userId &&
    first.purpose === locked.purpose &&
    first.deliveredEmail === locked.deliveredEmail &&
    first.normalizedEmail === locked.normalizedEmail &&
    first.subjectGeneration === locked.subjectGeneration &&
    first.issuanceGeneration === locked.issuanceGeneration &&
    first.issuedAt.getTime() === locked.issuedAt.getTime() &&
    first.expiresAt.getTime() === locked.expiresAt.getTime()
  );
}

/** A verification receipt never creates a session, a fresh-login claim or an owner reassignment. */
export async function consumeEmailVerification(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: VerifyEmailCommand,
): Promise<VerifyEmailReply> {
  const authority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const { token, email } = input.payload;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'verify-email', requestId } as const;
  const versioned = isVersionedEmailVerificationToken(token);
  const reservedIdentifier = !versioned && isReservedAuthRecordIdentifier(email);
  const supported = emailVerificationTokenSchema.safeParse(token).success;
  // Snapshot immutable owner BEFORE an asynchronous gate. Recheck the locked
  // receipt later; never follow a changed owner to another user's row.
  const [found] = supported
    ? await database
        .select()
        .from(authEmailVerificationTokens)
        .where(eq(authEmailVerificationTokens.tokenHash, tokenHash(token)))
    : [];
  const initial = found
    ? { ...found, issuedAt: new Date(found.issuedAt.getTime()), expiresAt: new Date(found.expiresAt.getTime()) }
    : undefined;
  return database.transaction(async (transaction): Promise<VerifyEmailReply> => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
    const claimed = await claimCommand(transaction, { operation: 'verify-email', requestId, issuedAt });
    assertFresh(issuedAt);
    if (!claimed) return { ...base, outcome: 'error', code: 'replayed' };
    // Even a negative authoritative outcome consumes its command ID. This
    // guard still precedes every lookup of the submitted legacy record.
    if (reservedIdentifier) return { ...base, outcome: 'invalid_token' };
    if (!supported) {
      if (versioned)
        return /^ev1_/i.test(token)
          ? { ...base, outcome: 'invalid_token' }
          : { ...base, outcome: 'error', code: 'unavailable' };
      if (!email) return { ...base, outcome: 'invalid_token' };
      // READ ONLY legacy classification. Never resolve any current email owner,
      // delete an orphan, extend its deadline or import an invented binding.
      const [legacy] = await transaction
        .select({ expires: verificationTokens.expires })
        .from(verificationTokens)
        .where(and(eq(verificationTokens.identifier, email), eq(verificationTokens.token, token)))
        .for('share');
      const now = await clock(transaction);
      assertFresh(issuedAt);
      return !legacy
        ? { ...base, outcome: 'invalid_token' }
        : legacy.expires.getTime() <= now
          ? { ...base, outcome: 'expired' }
          : { ...base, outcome: 'legacy_unbound' };
    }
    if (!initial || initial.purpose !== purpose) return { ...base, outcome: 'invalid_token' };
    const owner = await reservationOwner(transaction, authority, initial.normalizedEmail);
    const user = await lockUserRowUnderManifest(transaction, initial.userId);
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, initial.userId))
      .for('update');
    const [state] = await transaction
      .select()
      .from(authEmailVerificationState)
      .where(
        and(eq(authEmailVerificationState.userId, initial.userId), eq(authEmailVerificationState.purpose, purpose)),
      )
      .for('update');
    const [receipt] = await transaction
      .select()
      .from(authEmailVerificationTokens)
      .where(eq(authEmailVerificationTokens.tokenHash, initial.tokenHash))
      .for('update');
    const now = await clock(transaction);
    assertFresh(issuedAt);
    if (
      !receipt ||
      !sameBinding(initial, receipt) ||
      receipt.consumedAt ||
      receipt.supersededAt ||
      !user ||
      owner !== initial.userId ||
      !state ||
      state.generation !== receipt.issuanceGeneration ||
      cutoff?.deletedAt ||
      (cutoff?.generation ?? 0) !== receipt.subjectGeneration ||
      normalizeAccountEmail(receipt.deliveredEmail) !== receipt.normalizedEmail ||
      normalizeAccountEmail(user.email) !== receipt.normalizedEmail
    )
      return { ...base, outcome: 'invalid_token' };
    if (receipt.expiresAt.getTime() <= now) return { ...base, outcome: 'expired' };
    // The conditional DB clock is the redemption linearization point. All
    // owner/state rows are already locked, so no pre-wait clock grants access.
    const [consumed] = await transaction
      .update(authEmailVerificationTokens)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(authEmailVerificationTokens.tokenHash, receipt.tokenHash),
          isNull(authEmailVerificationTokens.consumedAt),
          isNull(authEmailVerificationTokens.supersededAt),
          sql`${authEmailVerificationTokens.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ consumedAt: authEmailVerificationTokens.consumedAt });
    if (!consumed?.consumedAt) return { ...base, outcome: 'expired' };
    // Keep a durable terminal generation even after receipt cleanup. Replaying
    // an old unconsumed snapshot cannot revive this already-used capability.
    await transaction
      .update(authEmailVerificationState)
      .set({ generation: sql`${authEmailVerificationState.generation} + 1`, updatedAt: consumed.consumedAt })
      .where(
        and(eq(authEmailVerificationState.userId, receipt.userId), eq(authEmailVerificationState.purpose, purpose)),
      );
    if (!user.emailVerified)
      await transaction
        .update(users)
        .set({ emailVerified: consumed.consumedAt })
        .where(and(eq(users.id, user.id), isNull(users.emailVerified)));
    assertFresh(issuedAt);
    return { ...base, outcome: 'verified' };
  });
}
