import { createHash, randomBytes } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  isVersionedPasswordRecoveryToken,
  passwordRecoveryTokenSchema,
  type ForgotPasswordCommand,
  type ForgotPasswordReply,
  type ResetPasswordCommand,
  type ResetPasswordReply,
} from '@boardsesh/auth-protocol';
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
  captureAuthority,
  claimCommand,
  preflight,
  transactionSettings,
  type WebPasswordAuthority,
} from './command-context';
import {
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
} from './foundation-context';
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

/** No owner selection for blocked groups; stale or inconsistent evidence is unavailable. */
async function owner(
  transaction: CurrentStoreTransaction,
  authority: WebPasswordAuthority,
  key: string,
  required = false,
) {
  const [reservation] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, key))
    .for('update');
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
    const userId = await owner(transaction, authority, key);
    assertFresh(issuedAt);
    if (!userId) return { ...base, outcome: 'accepted' };
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).for('update');
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
  const passwordHash =
    initial && initialCredential && !initial.consumedAt && !initial.supersededAt && body
      ? await bcrypt.hash(body.password, 12)
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
      // Only this literal namespace is constructed. Never consume or clean up
      // any legacy row, and never infer its original owner from today's users.
      const email = legacyEmail?.success ? legacyEmail.data.email : undefined;
      if (!email) return { ...base, outcome: 'invalid_or_expired' };
      const [legacy] = await transaction
        .select({ expires: verificationTokens.expires })
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.identifier, `password-reset:${email}`),
            eq(verificationTokens.token, createHash('sha256').update(body.token).digest('hex')),
          ),
        );
      const now = await clock(transaction);
      assertFresh(issuedAt);
      return { ...base, outcome: legacy && legacy.expires.getTime() > now ? 'legacy_unbound' : 'invalid_or_expired' };
    }
    if (!initial || initial.purpose !== purpose || !initialCredential || !passwordHash)
      return { ...base, outcome: 'invalid_or_expired' };
    const userId = await owner(transaction, authority, initial.normalizedEmail, true);
    const [user] = await transaction.select().from(users).where(eq(users.id, initial.userId)).for('update');
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
