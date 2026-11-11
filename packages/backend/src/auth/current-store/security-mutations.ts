import { authSecurityMutationEvents, authSubjectCutoffs, users } from '@boardsesh/db/schema/auth';
import { and, eq, sql } from 'drizzle-orm';
import { retireDeletedSubjectEmails } from './email-reservations';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

export type CurrentSecurityMutationKind = 'password-set' | 'password-change' | 'password-reset' | 'account-deletion';
export type CurrentRevocationDomain = 'first-party' | 'partner';
const revocationKinds: ReadonlySet<string> = new Set([
  'password-set',
  'password-change',
  'password-reset',
  'account-deletion',
]);

/**
 * Append to the SAME outer transaction as the real credential write/deletion.
 * All failures must abort that outer transaction. This helper alone is neither
 * a credential command nor a legacy-validator/issuer fence or outbox dispatcher.
 */
export async function recordSecurityMutation(
  transaction: CurrentStoreTransaction,
  options: ExpectedCurrentStoreAuthority & {
    readonly operationId: string;
    readonly userId: string;
    readonly expectedGeneration: number;
    readonly kind: CurrentSecurityMutationKind;
    readonly domains: readonly CurrentRevocationDomain[];
  },
) {
  const expected = captureExpectedAuthority(options);
  const { operationId, userId, expectedGeneration, kind } = options;
  const domains = [...options.domains];
  if (
    !operationId ||
    operationId !== operationId.trim() ||
    !userId ||
    userId !== userId.trim() ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0 ||
    !revocationKinds.has(kind) ||
    domains.length !== 2 ||
    !domains.includes('first-party') ||
    !domains.includes('partner')
  )
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  const manifest = await lockEnforcedProjection(transaction, expected);
  // Every generation writer holds the climber's users row FOR UPDATE before the
  // cutoff row (section 4). Native issuance and refresh hold KEY SHARE on it and
  // read the generation after that lock, so this is what keeps a reset or
  // deletion from committing between their read and their refresh-row insert.
  // Re-entrant for callers that already hold it. A deletion has removed the row
  // in this transaction by now, which held the same lock, so nothing waits.
  await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  const [previousOperation] = await transaction
    .select({ operationId: authSecurityMutationEvents.operationId })
    .from(authSecurityMutationEvents)
    .where(eq(authSecurityMutationEvents.operationId, operationId));
  // Never acknowledge a duplicate after a caller might have written a new
  // password. Even a matching operation ID aborts the whole caller transaction.
  if (previousOperation) throw new CurrentStoreFoundationError('DUPLICATE_OPERATION');
  await transaction
    .insert(authSubjectCutoffs)
    .values({ userId, generation: 0, revokedThrough: sql`clock_timestamp()`, lastOperationId: operationId })
    .onConflictDoNothing();
  const [previous] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  if (!previous || previous.generation !== expectedGeneration)
    throw new CurrentStoreFoundationError('STALE_GENERATION');
  if (previous.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
  const [cutoff] = await transaction
    .update(authSubjectCutoffs)
    .set({
      generation: sql`${authSubjectCutoffs.generation} + 1`,
      revokedThrough: sql`greatest(${authSubjectCutoffs.revokedThrough}, clock_timestamp())`,
      lastOperationId: operationId,
      ...(kind === 'account-deletion' ? { deletedAt: sql`clock_timestamp()` } : {}),
    })
    .where(and(eq(authSubjectCutoffs.userId, userId), eq(authSubjectCutoffs.generation, expectedGeneration)))
    .returning();
  if (!cutoff) throw new CurrentStoreFoundationError('STALE_GENERATION');
  const [event] = await transaction
    .insert(authSecurityMutationEvents)
    .values({
      operationId,
      userId,
      generation: cutoff.generation,
      previousGeneration: expectedGeneration,
      kind,
      domains: ['first-party', 'partner'],
      revokedThrough: cutoff.revokedThrough,
      writerEpoch: manifest.writerEpoch,
      projectionId: manifest.projectionId,
      payloadVersion: 1,
    })
    .returning();
  if (!event) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  // Keep only a keyed digest of the deleted address (decision 1, epic #6975). A
  // group the account shared stays blocked and never elects a surviving owner.
  if (kind === 'account-deletion') await retireDeletedSubjectEmails(transaction, userId);
  return { cutoff, event };
}
