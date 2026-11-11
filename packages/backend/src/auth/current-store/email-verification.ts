import { createHash, randomBytes } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
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
  boundSignInLockWaits,
  captureAuthority,
  claimCommand,
  claimLegacyLink,
  transactionSettings,
  type WebPasswordAuthority,
} from './command-context';
import { lockKeyReservation } from './email-reservations';
import { lockEnforcedProjection, lockSubjectRow, type CurrentStoreTransaction } from './foundation-context';
import { accountsHoldingAddress, isEmailUniquenessEnforced, issuedBeforeRevocation } from './legacy-link-binding';

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

/**
 * Who owns the key, read without a lock. Only a hint for which climber to lock
 * first: the caller locks that climber's row, then re-reads the owner locked.
 */
async function reservationOwnerHint(transaction: CurrentStoreTransaction, key: string) {
  const [reservation] = await transaction
    .select({ ownerUserId: authEmailReservations.ownerUserId })
    .from(authEmailReservations)
    .where(and(eq(authEmailReservations.normalizedEmail, key), eq(authEmailReservations.state, 'owned')));
  return reservation?.ownerUserId ?? null;
}

/** Call with the claimed owner's users row already locked (section 4's lock order). */
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

/** Caller already holds the gate; IDs come only from registration or a proven reservation. */
export async function issueEmailVerification(
  transaction: CurrentStoreTransaction,
  authorityInput: WebPasswordAuthority,
  userIdInput: string,
): Promise<RegistrationMailPlan | null> {
  const authority = captureAuthority(authorityInput);
  const userId = userIdInput;
  await lockEnforcedProjection(transaction, authority);
  // The climber's row before their reservation, the order account deletion uses too.
  const user = await lockSubjectRow(transaction, userId);
  if (!user || user.emailVerified) return null;
  const key = normalizeAccountEmail(user.email);
  if ((await reservationOwner(transaction, authority, key)) !== userId) return null;
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
    // issueEmailVerification locks this climber, then re-reads the owner locked.
    // Unauthenticated like forgot-password: 250 ms on a held row, then unavailable.
    const owner = await reservationOwnerHint(transaction, normalizeAccountEmail(email));
    if (owner) await boundSignInLockWaits(transaction);
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

/**
 * A pre-switch verification link, once BA-02 makes addresses unique: it binds
 * to the one account holding its exact address, ends at its original deadline,
 * works once, and dies on any later recorded security mutation, as a UID-bound receipt
 * does. Lock order: gate (held), the owner's user row, reservation, cutoff (BA-04
 * section 4, the order deletion uses). The owner is read unlocked first only to
 * know which row to lock; the locked re-read decides.
 */
async function consumeBoundLegacyVerification(
  transaction: CurrentStoreTransaction,
  authority: WebPasswordAuthority,
  link: { readonly email: string; readonly token: string; readonly deadline: Date; readonly now: number },
): Promise<'verified' | 'invalid_token' | 'expired' | 'legacy_unbound'> {
  if (!(await isEmailUniquenessEnforced(transaction))) return 'legacy_unbound';
  // The old issuer gave every link 24 hours. A longer deadline is not one it made.
  if (link.deadline.getTime() > link.now + lifetimeMs + AUTH_COMMAND_FUTURE_SKEW_MS) return 'invalid_token';
  const key = normalizeAccountEmail(link.email);
  const hinted = await reservationOwnerHint(transaction, key);
  const user = hinted ? await lockSubjectRow(transaction, hinted) : undefined;
  const owner = await reservationOwner(transaction, authority, key);
  if (!owner)
    return (await lockKeyReservation(transaction, key))?.state === 'blocked_deleted'
      ? 'invalid_token'
      : 'legacy_unbound';
  // An owner that appeared after the unlocked read is an account newer than the link.
  if (owner !== hinted) return 'invalid_token';
  const holders = await accountsHoldingAddress(transaction, key);
  if (!user || normalizeAccountEmail(user.email) !== key || holders.length !== 1 || holders[0].id !== owner)
    return 'invalid_token';
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, owner))
    .for('update');
  if (cutoff?.deletedAt || issuedBeforeRevocation(link.deadline, lifetimeMs, cutoff)) return 'invalid_token';
  // Read after every lock wait: the deadline is checked at the moment of use.
  const verifiedAt = new Date(await clock(transaction));
  if (link.deadline.getTime() <= verifiedAt.getTime()) return 'expired';
  const claimed = await claimLegacyLink(transaction, {
    purpose,
    identifier: link.email,
    storedToken: link.token,
    expires: link.deadline,
  });
  if (!claimed) return 'invalid_token';
  if (!user.emailVerified)
    await transaction
      .update(users)
      .set({ emailVerified: verifiedAt })
      .where(and(eq(users.id, owner), isNull(users.emailVerified)));
  return 'verified';
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
      // The old row is never changed, removed or given a later deadline. Until
      // BA-02 makes addresses unique, its original owner cannot be inferred
      // from today's users, and a live link stays unbound.
      const [legacy] = await transaction
        .select({ expires: verificationTokens.expires })
        .from(verificationTokens)
        .where(and(eq(verificationTokens.identifier, email), eq(verificationTokens.token, token)));
      const now = await clock(transaction);
      assertFresh(issuedAt);
      if (!legacy) return { ...base, outcome: 'invalid_token' };
      if (legacy.expires.getTime() <= now) return { ...base, outcome: 'expired' };
      const outcome = await consumeBoundLegacyVerification(transaction, authority, {
        email,
        token,
        deadline: new Date(legacy.expires.getTime()),
        now,
      });
      assertFresh(issuedAt);
      return { ...base, outcome };
    }
    if (!initial || initial.purpose !== purpose) return { ...base, outcome: 'invalid_token' };
    const user = await lockSubjectRow(transaction, initial.userId);
    const owner = await reservationOwner(transaction, authority, initial.normalizedEmail);
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
