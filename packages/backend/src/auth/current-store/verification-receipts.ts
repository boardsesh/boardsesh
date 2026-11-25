import { createHash, randomBytes } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import type { RegistrationMailPlan } from '@boardsesh/auth-protocol';
import {
  authEmailVerificationState,
  authEmailVerificationTokens,
  users,
  authSubjectCutoffs,
} from '@boardsesh/db/schema/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeAccountEmail } from '../normalize-email';
import type { CurrentStoreTransaction } from './foundation-context';
import { assertFresh } from './command-context';

const purpose = 'email-verification' as const;
const lifetimeMs = 24 * 60 * 60 * 1000;
type VerificationReceipt = typeof authEmailVerificationTokens.$inferSelect;
type VerificationUser = Pick<typeof users.$inferSelect, 'id' | 'email' | 'emailVerified'>;
type VerificationCutoff = Pick<typeof authSubjectCutoffs.$inferSelect, 'generation' | 'deletedAt'> | undefined;

export const emailVerificationTokenHash = (token: string) =>
  createHash('sha256').update(`email-verification-v1\0${token}`).digest('hex');

export async function verificationClock(transaction: CurrentStoreTransaction): Promise<number> {
  const instant = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  const milliseconds = Number(instant?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Verification clock unavailable');
  return milliseconds;
}

/** Caller holds its writer gate, this UID's user row and then its cutoff row. */
export async function issueUidEmailVerification(
  transaction: CurrentStoreTransaction,
  user: VerificationUser,
  cutoff: VerificationCutoff,
): Promise<RegistrationMailPlan | null> {
  if (user.emailVerified || cutoff?.deletedAt) return null;
  const recipient = user.email.trim();
  if (!z.email().safeParse(recipient).success) return null;
  const key = normalizeAccountEmail(user.email);
  await transaction
    .insert(authEmailVerificationState)
    .values({ userId: user.id, purpose, generation: 0 })
    .onConflictDoNothing();
  const [state] = await transaction
    .select()
    .from(authEmailVerificationState)
    .where(and(eq(authEmailVerificationState.userId, user.id), eq(authEmailVerificationState.purpose, purpose)))
    .for('update');
  if (!state) throw new Error('Verification state unavailable');
  const issuedAt = new Date(await verificationClock(transaction));
  const expiresAt = new Date(issuedAt.getTime() + lifetimeMs);
  const [next] = await transaction
    .update(authEmailVerificationState)
    .set({ generation: sql`${authEmailVerificationState.generation} + 1`, updatedAt: issuedAt })
    .where(and(eq(authEmailVerificationState.userId, user.id), eq(authEmailVerificationState.purpose, purpose)))
    .returning();
  if (!next) throw new Error('Verification generation unavailable');
  await transaction
    .update(authEmailVerificationTokens)
    .set({ supersededAt: issuedAt })
    .where(
      and(
        eq(authEmailVerificationTokens.userId, user.id),
        eq(authEmailVerificationTokens.purpose, purpose),
        isNull(authEmailVerificationTokens.consumedAt),
        isNull(authEmailVerificationTokens.supersededAt),
      ),
    );
  const token = `ev1_${randomBytes(32).toString('base64url')}`;
  await transaction.insert(authEmailVerificationTokens).values({
    tokenHash: emailVerificationTokenHash(token),
    userId: user.id,
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

/** Snapshot the immutable binding before waiting for the writer gate. */
export async function readUidEmailVerification(database: DbInstance, token: string) {
  const [found] = await database
    .select()
    .from(authEmailVerificationTokens)
    .where(eq(authEmailVerificationTokens.tokenHash, emailVerificationTokenHash(token)));
  return found
    ? { ...found, issuedAt: new Date(found.issuedAt.getTime()), expiresAt: new Date(found.expiresAt.getTime()) }
    : undefined;
}

function sameBinding(first: VerificationReceipt, locked: VerificationReceipt) {
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
 * Caller holds gate, bound user and cutoff, after its own ownership checks.
 * State/receipt consumption and the selected writer's verification commit in
 * that same transaction. This primitive selects no account and issues no login.
 */
export async function consumeUidEmailVerification(
  transaction: CurrentStoreTransaction,
  initial: VerificationReceipt,
  user: VerificationUser | undefined,
  cutoff: VerificationCutoff,
  issuedAt: number,
  verify: (verifiedAt: Date) => Promise<void>,
): Promise<'verified' | 'invalid_token' | 'expired'> {
  const [state] = await transaction
    .select()
    .from(authEmailVerificationState)
    .where(and(eq(authEmailVerificationState.userId, initial.userId), eq(authEmailVerificationState.purpose, purpose)))
    .for('update');
  const [receipt] = await transaction
    .select()
    .from(authEmailVerificationTokens)
    .where(eq(authEmailVerificationTokens.tokenHash, initial.tokenHash))
    .for('update');
  const now = await verificationClock(transaction);
  assertFresh(issuedAt);
  if (
    initial.purpose !== purpose ||
    !receipt ||
    !sameBinding(initial, receipt) ||
    receipt.consumedAt ||
    receipt.supersededAt ||
    !user ||
    user.id !== initial.userId ||
    !state ||
    state.generation !== receipt.issuanceGeneration ||
    cutoff?.deletedAt ||
    (cutoff?.generation ?? 0) !== receipt.subjectGeneration ||
    normalizeAccountEmail(receipt.deliveredEmail) !== receipt.normalizedEmail ||
    normalizeAccountEmail(user.email) !== receipt.normalizedEmail
  )
    return 'invalid_token';
  if (receipt.expiresAt.getTime() <= now) return 'expired';
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
  if (!consumed?.consumedAt) return 'expired';
  await transaction
    .update(authEmailVerificationState)
    .set({ generation: sql`${authEmailVerificationState.generation} + 1`, updatedAt: consumed.consumedAt })
    .where(and(eq(authEmailVerificationState.userId, receipt.userId), eq(authEmailVerificationState.purpose, purpose)));
  await verify(consumed.consumedAt);
  assertFresh(issuedAt);
  return 'verified';
}
