import { createHash, randomBytes } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_PROTOCOL_VERSION,
  isVersionedPasswordRecoveryToken,
  passwordRecoveryTokenSchema,
  type ForgotPasswordCommand,
  type ForgotPasswordReply,
  type ResetPasswordCommand,
  type ResetPasswordReply,
} from '@boardsesh/auth-protocol';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import {
  authEmailReservationMembers,
  authEmailReservations,
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { normalizeAccountEmail } from '../normalize-email';
import {
  assertFresh,
  boundSignInLockWaits,
  captureAuthority,
  claimCommand,
  claimLegacyLink,
  preflight,
  transactionSettings,
  type WebPasswordAuthority,
} from './command-context';
import { lockKeyReservation } from './email-reservations';
import {
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  lockSubjectRow,
  type CurrentStoreTransaction,
} from './foundation-context';
import { accountsHoldingAddress, isEmailUniquenessEnforced, issuedBeforeRevocation } from './legacy-link-binding';
import { recordSecurityMutation } from './security-mutations';

const purpose = 'password-reset' as const;
const lifetimeMs = 60 * 60 * 1000;
const forgotSchema = z.object({ email: z.string().email('Invalid email address') });
const resetSchema = z
  .object({
    // A versioned receipt is the authority. The released email field is only a
    // compatibility hint; unversioned legacy classification validates it below.
    email: z.unknown().optional(),
    token: z.string().min(1, 'Invalid reset token').max(256, 'Invalid reset token'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must be less than 128 characters'),
    confirmPassword: z.string(),
  })
  .refine((body) => body.password === body.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
const digest = (token: string) => createHash('sha256').update(`password-recovery-v1\0${token}`).digest('hex');

async function clock(transaction: CurrentStoreTransaction) {
  const instant = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  const milliseconds = Number(instant?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Recovery clock unavailable');
  return milliseconds;
}

/**
 * Who owns the key, read without a lock. Only a hint for which climber to lock
 * first: the caller locks that climber's row, then re-reads the owner locked.
 */
async function ownerHint(transaction: CurrentStoreTransaction, key: string) {
  const [reservation] = await transaction
    .select({ ownerUserId: authEmailReservations.ownerUserId })
    .from(authEmailReservations)
    .where(and(eq(authEmailReservations.normalizedEmail, key), eq(authEmailReservations.state, 'owned')));
  return reservation?.ownerUserId ?? null;
}

/**
 * No owner selection for blocked groups; stale or inconsistent evidence is
 * unavailable. Call with the claimed owner's users row already locked: section
 * 4's lock order puts a climber's row before their reservation, as account
 * deletion takes them, so the two can never wait on each other in a cycle.
 */
async function owner(
  transaction: CurrentStoreTransaction,
  authority: WebPasswordAuthority,
  key: string,
  required = false,
) {
  // A deleted owner's key survives only as its digest row, which is never owned.
  const reservation = await lockKeyReservation(transaction, key);
  if (!reservation) {
    if (required) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    return null;
  }
  if (reservation.basisProjectionId !== authority.expectedProjectionId)
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  if (reservation.state !== 'owned') return null;
  const members = await transaction
    .select()
    .from(authEmailReservationMembers)
    .where(eq(authEmailReservationMembers.normalizedEmail, key))
    .limit(2)
    .for('update');
  if (!reservation.ownerUserId || members.length !== 1 || members[0].userId !== reservation.ownerUserId)
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  return reservation.ownerUserId;
}

export async function requestPasswordRecovery(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: ForgotPasswordCommand,
): Promise<ForgotPasswordReply> {
  const authority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const parsed = forgotSchema.safeParse(input.payload);
  const email = parsed.success ? parsed.data.email : undefined;
  const message = parsed.success ? undefined : parsed.error.issues[0].message;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'forgot-password', requestId } as const;
  return database.transaction(async (transaction): Promise<ForgotPasswordReply> => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
    const claimed = await claimCommand(transaction, { operation: 'forgot-password', requestId, issuedAt });
    assertFresh(issuedAt);
    if (!claimed) return { ...base, outcome: 'error', code: 'replayed' };
    if (!email || message)
      return {
        ...base,
        outcome: 'error',
        code: 'validation_error',
        message: message as Extract<ForgotPasswordReply, { code: 'validation_error' }>['message'],
      };
    const key = normalizeAccountEmail(email);
    const hinted = await ownerHint(transaction, key);
    // Unauthenticated, so it must not hold a pool connection for 4 s behind a
    // held row: 250 ms, then unavailable (SIGN_IN_LOCK_TIMEOUT).
    await boundSignInLockWaits(transaction);
    const user = hinted ? await lockSubjectRow(transaction, hinted) : undefined;
    const userId = await owner(transaction, authority, key);
    assertFresh(issuedAt);
    // A key that gained an owner after the hint belongs to an account created
    // this instant; its row would be locked after the reservation, so send nothing.
    if (!userId || userId !== hinted) return { ...base, outcome: 'accepted' };
    if (!user || normalizeAccountEmail(user.email) !== key)
      throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    const [credential] = await transaction
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, userId))
      .for('update');
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId))
      .for('update');
    assertFresh(issuedAt);
    if (!credential || cutoff?.deletedAt) return { ...base, outcome: 'accepted' };
    const recipient = user.email.trim();
    if (!z.email().safeParse(recipient).success) return { ...base, outcome: 'accepted' };
    await transaction
      .insert(authPasswordRecoveryState)
      .values({ userId, purpose, generation: 0 })
      .onConflictDoNothing();
    const [state] = await transaction
      .select()
      .from(authPasswordRecoveryState)
      .where(and(eq(authPasswordRecoveryState.userId, userId), eq(authPasswordRecoveryState.purpose, purpose)))
      .for('update');
    if (!state) throw new Error('Recovery state unavailable');
    const issued = new Date(await clock(transaction));
    const expiresAt = new Date(issued.getTime() + lifetimeMs);
    const [next] = await transaction
      .update(authPasswordRecoveryState)
      .set({ generation: sql`${authPasswordRecoveryState.generation} + 1`, updatedAt: issued })
      .where(and(eq(authPasswordRecoveryState.userId, userId), eq(authPasswordRecoveryState.purpose, purpose)))
      .returning();
    if (!next) throw new Error('Recovery generation unavailable');
    await transaction
      .update(authPasswordRecoveryTokens)
      .set({ supersededAt: issued })
      .where(
        and(
          eq(authPasswordRecoveryTokens.userId, userId),
          eq(authPasswordRecoveryTokens.purpose, purpose),
          isNull(authPasswordRecoveryTokens.consumedAt),
          isNull(authPasswordRecoveryTokens.supersededAt),
        ),
      );
    const token = `pr1_${randomBytes(32).toString('base64url')}`;
    await transaction.insert(authPasswordRecoveryTokens).values({
      tokenHash: digest(token),
      userId,
      purpose,
      deliveredEmail: recipient,
      normalizedEmail: key,
      subjectGeneration: cutoff?.generation ?? 0,
      issuanceGeneration: next.generation,
      issuedAt: issued,
      expiresAt,
    });
    assertFresh(issuedAt);
    return {
      ...base,
      outcome: 'accepted',
      mailPlan: { kind: 'uid-password-reset-v1', recipient, token, expiresAt: expiresAt.toISOString() },
    };
  });
}

type Receipt = typeof authPasswordRecoveryTokens.$inferSelect;
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

type LegacyResetPreview = { readonly userId: string; readonly passwordHash: string };

/**
 * Unlocked read before bcrypt, as the UID-bound path reads its receipt: the
 * account a live pre-switch link would bind to, and its current hash. Nothing
 * here grants anything; the transaction checks it all again under locks.
 */
async function previewLegacyResetOwner(
  database: DbInstance,
  email: string,
  token: string,
): Promise<LegacyResetPreview | undefined> {
  if (!(await isEmailUniquenessEnforced(database))) return undefined;
  const [link] = await database
    .select({ expires: verificationTokens.expires })
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, `password-reset:${email}`),
        eq(verificationTokens.token, createHash('sha256').update(token).digest('hex')),
      ),
    );
  if (!link || link.expires.getTime() <= Date.now()) return undefined;
  const holders = await accountsHoldingAddress(database, normalizeAccountEmail(email));
  if (holders.length !== 1) return undefined;
  const [credential] = await database.select().from(userCredentials).where(eq(userCredentials.userId, holders[0].id));
  return credential ? { userId: credential.userId, passwordHash: credential.passwordHash } : undefined;
}

/**
 * A pre-switch reset link, once BA-02 makes addresses unique: it binds to the
 * one account holding its exact address, ends at its original deadline, works
 * once, and dies on any later recorded security mutation. Then it resets exactly as a
 * UID-bound receipt does. Same lock order: gate (held), the previewed user,
 * reservation, credential, cutoff (BA-04 section 4, the order deletion uses).
 */
async function consumeBoundLegacyReset(
  transaction: CurrentStoreTransaction,
  authority: WebPasswordAuthority,
  link: {
    readonly requestId: string;
    readonly email: string;
    readonly identifier: string;
    readonly storedToken: string;
    readonly deadline: Date;
    readonly now: number;
    readonly preview: LegacyResetPreview;
    readonly passwordHash: string;
  },
): Promise<'reset' | 'invalid_or_expired' | 'legacy_unbound'> {
  if (!(await isEmailUniquenessEnforced(transaction))) return 'legacy_unbound';
  // The old issuer gave every link one hour. A longer deadline is not one it made.
  if (link.deadline.getTime() > link.now + lifetimeMs + AUTH_COMMAND_FUTURE_SKEW_MS) return 'invalid_or_expired';
  const key = normalizeAccountEmail(link.email);
  const user = await lockSubjectRow(transaction, link.preview.userId);
  const userId = await owner(transaction, authority, key);
  if (!userId)
    return (await lockKeyReservation(transaction, key))?.state === 'blocked_deleted'
      ? 'invalid_or_expired'
      : 'legacy_unbound';
  if (userId !== link.preview.userId) return 'legacy_unbound';
  const holders = await accountsHoldingAddress(transaction, key);
  if (!user || normalizeAccountEmail(user.email) !== key || holders.length !== 1 || holders[0].id !== userId)
    return 'invalid_or_expired';
  const [credential] = await transaction
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId))
    .for('update');
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  // Read after every lock wait: the deadline is checked at the moment of use.
  const resetAt = new Date(await clock(transaction));
  if (
    !credential ||
    credential.passwordHash !== link.preview.passwordHash ||
    cutoff?.deletedAt ||
    issuedBeforeRevocation(link.deadline, lifetimeMs, cutoff) ||
    link.deadline.getTime() <= resetAt.getTime()
  )
    return 'invalid_or_expired';
  const claimed = await claimLegacyLink(transaction, {
    purpose,
    identifier: link.identifier,
    storedToken: link.storedToken,
    expires: link.deadline,
  });
  if (!claimed) return 'invalid_or_expired';
  const [changed] = await transaction
    .update(userCredentials)
    .set({ passwordHash: link.passwordHash, updatedAt: resetAt })
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.passwordHash, link.preview.passwordHash)))
    .returning({ userId: userCredentials.userId });
  if (!changed) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  if (!user.emailVerified)
    await transaction
      .update(users)
      .set({ emailVerified: resetAt, updatedAt: resetAt })
      .where(and(eq(users.id, userId), isNull(users.emailVerified)));
  await recordSecurityMutation(transaction, {
    ...authority,
    operationId: link.requestId,
    userId,
    expectedGeneration: cutoff?.generation ?? 0,
    kind: 'password-reset',
    domains: ['first-party', 'partner'],
  });
  await transaction
    .update(mobileRefreshTokens)
    .set({ revokedAt: resetAt })
    .where(and(eq(mobileRefreshTokens.userId, userId), isNull(mobileRefreshTokens.revokedAt)));
  return 'reset';
}

/** Records revocation intent; legacy issuers/validators are NOT adopted here. */
export async function consumePasswordRecovery(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: ResetPasswordCommand,
): Promise<ResetPasswordReply> {
  const authority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const rawToken =
    input.payload && typeof input.payload === 'object' && 'token' in input.payload ? input.payload.token : undefined;
  const versioned = typeof rawToken === 'string' && isVersionedPasswordRecoveryToken(rawToken);
  const unsupportedFormat =
    typeof rawToken === 'string' && (rawToken.length > 256 || (versioned && !/^pr1_/i.test(rawToken)));
  const parsed = resetSchema.safeParse(input.payload);
  const body = parsed.success ? parsed.data : undefined;
  const message = parsed.success ? undefined : parsed.error.issues[0].message;
  const token = body?.token;
  const supported = passwordRecoveryTokenSchema.safeParse(token).success;
  const legacyEmail = body && !versioned ? forgotSchema.safeParse({ email: body.email }) : undefined;
  const legacyMessage = legacyEmail && !legacyEmail.success ? legacyEmail.error.issues[0].message : undefined;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'reset-password', requestId } as const;
  // Enforced authority is checked before expensive hashing, without retaining
  // the manifest lock through bcrypt. No preliminary read grants redemption.
  await preflight(database, authority);
  const [found] = supported
    ? await database
        .select()
        .from(authPasswordRecoveryTokens)
        .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token!)))
    : [];
  const initial = found
    ? { ...found, issuedAt: new Date(found.issuedAt.getTime()), expiresAt: new Date(found.expiresAt.getTime()) }
    : undefined;
  const [beforeCredential] = initial
    ? await database.select().from(userCredentials).where(eq(userCredentials.userId, initial.userId))
    : [];
  const initialCredential = beforeCredential
    ? { userId: beforeCredential.userId, passwordHash: beforeCredential.passwordHash }
    : undefined;
  const legacyAddress = legacyEmail?.success ? legacyEmail.data.email : undefined;
  const legacyPreview =
    !supported && !versioned && body && legacyAddress
      ? await previewLegacyResetOwner(database, legacyAddress, body.token)
      : undefined;
  const passwordHash =
    body && ((initial && initialCredential && !initial.consumedAt && !initial.supersededAt) || legacyPreview)
      ? await bcrypt.hash(body.password, PASSWORD_HASH_COST)
      : undefined;
  return database.transaction(async (transaction): Promise<ResetPasswordReply> => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
    const claimed = await claimCommand(transaction, { operation: 'reset-password', requestId, issuedAt });
    assertFresh(issuedAt);
    if (!claimed) return { ...base, outcome: 'error', code: 'replayed' };
    if (unsupportedFormat) return { ...base, outcome: 'error', code: 'unavailable' };
    if (!body || message || legacyMessage)
      return {
        ...base,
        outcome: 'error',
        code: 'validation_error',
        message: (message ?? legacyMessage) as Extract<ResetPasswordReply, { code: 'validation_error' }>['message'],
      };
    if (!supported) {
      if (versioned)
        return /^pr1_/i.test(body.token)
          ? { ...base, outcome: 'invalid_or_expired' }
          : { ...base, outcome: 'error', code: 'unavailable' };
      // Only this literal namespace is constructed, from the exact address the
      // link carries. The old row is never changed or removed. Until BA-02
      // makes addresses unique, its original owner cannot be inferred from
      // today's users, and a live link stays unbound.
      const email = legacyEmail?.success ? legacyEmail.data.email : undefined;
      if (!email) return { ...base, outcome: 'invalid_or_expired' };
      const identifier = `password-reset:${email}`;
      const storedToken = createHash('sha256').update(body.token).digest('hex');
      const [legacy] = await transaction
        .select({ expires: verificationTokens.expires })
        .from(verificationTokens)
        .where(and(eq(verificationTokens.identifier, identifier), eq(verificationTokens.token, storedToken)));
      const now = await clock(transaction);
      assertFresh(issuedAt);
      if (!legacy || legacy.expires.getTime() <= now) return { ...base, outcome: 'invalid_or_expired' };
      if (!legacyPreview || !passwordHash) return { ...base, outcome: 'legacy_unbound' };
      const outcome = await consumeBoundLegacyReset(transaction, authority, {
        requestId,
        email,
        identifier,
        storedToken,
        deadline: new Date(legacy.expires.getTime()),
        now,
        preview: legacyPreview,
        passwordHash,
      });
      assertFresh(issuedAt);
      return { ...base, outcome };
    }
    if (!initial || initial.purpose !== purpose || !initialCredential || !passwordHash)
      return { ...base, outcome: 'invalid_or_expired' };
    const user = await lockSubjectRow(transaction, initial.userId);
    const userId = await owner(transaction, authority, initial.normalizedEmail, true);
    const [credential] = await transaction
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, initial.userId))
      .for('update');
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, initial.userId))
      .for('update');
    const [state] = await transaction
      .select()
      .from(authPasswordRecoveryState)
      .where(and(eq(authPasswordRecoveryState.userId, initial.userId), eq(authPasswordRecoveryState.purpose, purpose)))
      .for('update');
    const [receipt] = await transaction
      .select()
      .from(authPasswordRecoveryTokens)
      .where(eq(authPasswordRecoveryTokens.tokenHash, initial.tokenHash))
      .for('update');
    const now = await clock(transaction);
    assertFresh(issuedAt);
    if (
      !receipt ||
      !sameBinding(initial, receipt) ||
      receipt.consumedAt ||
      receipt.supersededAt ||
      receipt.expiresAt.getTime() <= now ||
      !user ||
      userId !== initial.userId ||
      !credential ||
      credential.userId !== initialCredential.userId ||
      credential.passwordHash !== initialCredential.passwordHash ||
      !state ||
      state.generation !== receipt.issuanceGeneration ||
      cutoff?.deletedAt ||
      (cutoff?.generation ?? 0) !== receipt.subjectGeneration ||
      normalizeAccountEmail(receipt.deliveredEmail) !== receipt.normalizedEmail ||
      normalizeAccountEmail(user.email) !== receipt.normalizedEmail
    )
      return { ...base, outcome: 'invalid_or_expired' };
    const [consumed] = await transaction
      .update(authPasswordRecoveryTokens)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(authPasswordRecoveryTokens.tokenHash, receipt.tokenHash),
          isNull(authPasswordRecoveryTokens.consumedAt),
          isNull(authPasswordRecoveryTokens.supersededAt),
          sql`${authPasswordRecoveryTokens.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ consumedAt: authPasswordRecoveryTokens.consumedAt });
    if (!consumed?.consumedAt) return { ...base, outcome: 'invalid_or_expired' };
    await transaction
      .update(authPasswordRecoveryState)
      .set({ generation: sql`${authPasswordRecoveryState.generation} + 1`, updatedAt: consumed.consumedAt })
      .where(and(eq(authPasswordRecoveryState.userId, receipt.userId), eq(authPasswordRecoveryState.purpose, purpose)));
    const [changed] = await transaction
      .update(userCredentials)
      .set({ passwordHash, updatedAt: consumed.consumedAt })
      .where(
        and(
          eq(userCredentials.userId, receipt.userId),
          eq(userCredentials.passwordHash, initialCredential.passwordHash),
        ),
      )
      .returning({ userId: userCredentials.userId });
    if (!changed) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    if (!user.emailVerified)
      await transaction
        .update(users)
        .set({ emailVerified: consumed.consumedAt, updatedAt: consumed.consumedAt })
        .where(and(eq(users.id, receipt.userId), isNull(users.emailVerified)));
    await recordSecurityMutation(transaction, {
      ...authority,
      operationId: requestId,
      userId: receipt.userId,
      expectedGeneration: receipt.subjectGeneration,
      kind: 'password-reset',
      domains: ['first-party', 'partner'],
    });
    await transaction
      .update(mobileRefreshTokens)
      .set({ revokedAt: consumed.consumedAt })
      .where(and(eq(mobileRefreshTokens.userId, receipt.userId), isNull(mobileRefreshTokens.revokedAt)));
    assertFresh(issuedAt);
    return { ...base, outcome: 'reset' };
  });
}
