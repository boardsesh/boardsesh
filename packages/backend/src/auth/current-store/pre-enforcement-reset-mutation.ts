import { authPreEnforcementPasswordResetEvents, authSubjectCutoffs, users } from '@boardsesh/db/schema/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { CurrentStoreFoundationError, type CurrentStoreTransaction } from './foundation-context';
import { revalidatePreEnforcementContext, type PreEnforcementContext } from './pre-enforcement-context';

/**
 * Only after a real password write in this same outer transaction. The caller
 * already holds the gate, user, cutoff and credential locks in that order.
 * Every error must abort token consumption and the actual password mutation.
 * This returns no authority or session-continuation receipt.
 */
export async function recordPreEnforcementPasswordReset(
  transaction: CurrentStoreTransaction,
  context: PreEnforcementContext,
  options: {
    readonly operationId: string;
    readonly userId: string;
    readonly expectedGeneration: number;
  },
): Promise<void> {
  const { userId, expectedGeneration } = options;
  const operationId = options.operationId.toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId) ||
    !userId ||
    userId !== userId.trim() ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0
  )
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  await revalidatePreEnforcementContext(transaction, context);
  const [user] = await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  if (!user) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
  const [previousOperation] = await transaction
    .select({ operationId: authPreEnforcementPasswordResetEvents.operationId })
    .from(authPreEnforcementPasswordResetEvents)
    .where(eq(authPreEnforcementPasswordResetEvents.operationId, operationId));
  // Never acknowledge a duplicate after the caller might have written a password.
  if (previousOperation) throw new CurrentStoreFoundationError('DUPLICATE_OPERATION');
  await transaction
    .insert(authSubjectCutoffs)
    .values({ userId, generation: 0, revokedThrough: new Date(0), lastOperationId: operationId })
    .onConflictDoNothing();
  const [cutoff] = await transaction
    .update(authSubjectCutoffs)
    .set({
      generation: sql`${authSubjectCutoffs.generation} + 1`,
      revokedThrough: sql`greatest(${authSubjectCutoffs.revokedThrough}, clock_timestamp())`,
      lastOperationId: operationId,
    })
    .where(
      and(
        eq(authSubjectCutoffs.userId, userId),
        eq(authSubjectCutoffs.generation, expectedGeneration),
        isNull(authSubjectCutoffs.deletedAt),
      ),
    )
    .returning();
  if (!cutoff) throw new CurrentStoreFoundationError('STALE_GENERATION');
  await transaction.insert(authPreEnforcementPasswordResetEvents).values({
    operationId,
    userId,
    previousGeneration: expectedGeneration,
    generation: cutoff.generation,
    kind: 'password-reset',
    domains: ['first-party', 'partner'],
    contextPhase: context.projectionId === null ? 'absent' : 'prepared',
    preparedProjectionId: context.projectionId,
    preparedWriterEpoch: context.writerEpoch,
    revokedThrough: cutoff.revokedThrough,
    recordedAt: sql`clock_timestamp()`,
  });
  await revalidatePreEnforcementContext(transaction, context);
}
