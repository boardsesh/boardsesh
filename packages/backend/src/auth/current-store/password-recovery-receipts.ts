import { createHash, randomBytes } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import { authPasswordRecoveryState, authPasswordRecoveryTokens } from '@boardsesh/db/schema/auth';
import type { PasswordRecoveryMailPlan } from '@boardsesh/auth-protocol';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { CurrentStoreFoundationError, type CurrentStoreTransaction } from './foundation-context';

export const PASSWORD_RECOVERY_PURPOSE = 'password-reset' as const;
export const PASSWORD_RECOVERY_LIFETIME_MS = 60 * 60 * 1000;
export type PasswordRecoveryReceipt = typeof authPasswordRecoveryTokens.$inferSelect;
export const hashPasswordRecoveryToken = (token: string) =>
  createHash('sha256').update(`password-recovery-v1\0${token}`).digest('hex');

export async function recoveryClock(transaction: CurrentStoreTransaction): Promise<number> {
  const instant = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  const milliseconds = Number(instant?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Recovery clock unavailable');
  return milliseconds;
}

/** Receipt mechanics only; each caller must independently authorize and lock the UID. */
export async function issueUidPasswordRecoveryReceipt(
  transaction: CurrentStoreTransaction,
  input: {
    readonly userId: string;
    readonly deliveredEmail: string;
    readonly normalizedEmail: string;
    readonly subjectGeneration: number;
  },
): Promise<PasswordRecoveryMailPlan> {
  const { userId, deliveredEmail, normalizedEmail, subjectGeneration } = input;
  const purpose = PASSWORD_RECOVERY_PURPOSE;
  await transaction.insert(authPasswordRecoveryState).values({ userId, purpose, generation: 0 }).onConflictDoNothing();
  const [state] = await transaction
    .select()
    .from(authPasswordRecoveryState)
    .where(and(eq(authPasswordRecoveryState.userId, userId), eq(authPasswordRecoveryState.purpose, purpose)))
    .for('update');
  if (!state) throw new Error('Recovery state unavailable');
  const issued = new Date(await recoveryClock(transaction));
  const expiresAt = new Date(issued.getTime() + PASSWORD_RECOVERY_LIFETIME_MS);
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
    tokenHash: hashPasswordRecoveryToken(token),
    userId,
    purpose,
    deliveredEmail,
    normalizedEmail,
    subjectGeneration,
    issuanceGeneration: next.generation,
    issuedAt: issued,
    expiresAt,
  });
  return { kind: 'uid-password-reset-v1', recipient: deliveredEmail, token, expiresAt: expiresAt.toISOString() };
}

export async function readUidPasswordRecoveryReceipt(database: Pick<DbInstance, 'select'>, token: string) {
  const [receipt] = await database
    .select()
    .from(authPasswordRecoveryTokens)
    .where(eq(authPasswordRecoveryTokens.tokenHash, hashPasswordRecoveryToken(token)));
  return receipt
    ? { ...receipt, issuedAt: new Date(receipt.issuedAt.getTime()), expiresAt: new Date(receipt.expiresAt.getTime()) }
    : undefined;
}

export function samePasswordRecoveryBinding(first: PasswordRecoveryReceipt, locked: PasswordRecoveryReceipt) {
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

/** Caller has locked and checked the UID, cutoff, purpose generation and immutable receipt. */
export async function consumeUidPasswordRecoveryReceipt(
  transaction: CurrentStoreTransaction,
  receipt: PasswordRecoveryReceipt,
): Promise<Date | null> {
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
  if (!consumed?.consumedAt) return null;
  const [advanced] = await transaction
    .update(authPasswordRecoveryState)
    .set({ generation: sql`${authPasswordRecoveryState.generation} + 1`, updatedAt: consumed.consumedAt })
    .where(
      and(
        eq(authPasswordRecoveryState.userId, receipt.userId),
        eq(authPasswordRecoveryState.purpose, receipt.purpose),
        eq(authPasswordRecoveryState.generation, receipt.issuanceGeneration),
      ),
    )
    .returning({ generation: authPasswordRecoveryState.generation });
  if (!advanced) throw new CurrentStoreFoundationError('STALE_GENERATION');
  return consumed.consumedAt;
}
