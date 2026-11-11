import {
  authEmailReservationMembers,
  authEmailReservations,
  authEmailVerificationTokens,
  authPasswordRecoveryTokens,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { and, eq, sql } from 'drizzle-orm';
import { lockSharedFixedSystemOwnerTransaction } from '@boardsesh/db/fixed-system-owner-order';
import { normalizeAccountEmail } from '../normalize-email';
import { transactionSettings } from './command-context';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';
import { recordSecurityMutation } from './security-mutations';

export interface CapturedAccountDeletionCommand extends ExpectedCurrentStoreAuthority {
  readonly userId: string;
  readonly operationId: string;
}

/** Read under this attempt's users row lock, so it cannot change before commit. */
export interface ReservedDeletionSubject {
  readonly email: string;
}

/** Trusted authenticated UID and server operation identity, never email resolution. */
export function captureAccountDeletionCommand(
  authority: ExpectedCurrentStoreAuthority,
  userId: string,
  operationId: string,
): CapturedAccountDeletionCommand {
  if (
    typeof userId !== 'string' ||
    !userId ||
    userId !== userId.trim() ||
    typeof operationId !== 'string' ||
    !operationId ||
    operationId !== operationId.trim()
  ) {
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  }
  return Object.freeze({ ...captureExpectedAuthority(authority), userId, operationId });
}

/**
 * Call first in the deletion transaction. Takes the authority gate shared and
 * validates the manifest, so a stale authority fails before any content is
 * touched, then the fixed-owner key; human subject/user locks come after walls.
 *
 * The gate is shared, so holding it through content and the cascade costs no
 * other command anything: commands never wait for each other on it. Only an
 * authority switch, holding it exclusively, waits for this deletion and gives up
 * after its own 2 s. Taking it here, before any row, means the deletion never
 * waits for the gate while holding a climber's row, so it cannot close a cycle
 * with a switch. The short limits cover these two statements only; content and
 * the cascade then run under the connection's ordinary limits, as legacy does.
 */
export async function beginReservedAccountDeletion(
  transaction: CurrentStoreTransaction,
  command: CapturedAccountDeletionCommand,
): Promise<void> {
  await transactionSettings(transaction);
  await lockEnforcedProjection(transaction, command);
  await transaction.execute(sql`SET LOCAL statement_timeout TO DEFAULT`);
  await transaction.execute(sql`SET LOCAL lock_timeout TO DEFAULT`);
  await lockSharedFixedSystemOwnerTransaction(transaction);
}

/**
 * Take the late human-user lock after the account and wall locks, before any
 * content changes. Returns undefined only when this UID's deletion already
 * committed: a retry after a lost response, or the loser of two racing requests
 * (the account lock parked it until the winner committed). The caller then ends
 * the transaction without writing. Absent with no tombstone stays an error, so
 * a tombstone is never invented for a UID that never existed.
 */
export async function lockReservedDeletionSubject(
  transaction: CurrentStoreTransaction,
  command: CapturedAccountDeletionCommand,
): Promise<ReservedDeletionSubject | undefined> {
  const [subject] = await transaction
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, command.userId))
    .limit(1)
    .for('update');
  if (subject) return subject;
  const [tombstone] = await transaction
    .select({ deletedAt: authSubjectCutoffs.deletedAt })
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, command.userId))
    .limit(1);
  if (!tombstone?.deletedAt) throw new CurrentStoreFoundationError('INVALID_COMMAND');
  return undefined;
}

async function requireRepresentedDeletionEmail(
  transaction: CurrentStoreTransaction,
  userId: string,
  email: string,
  projectionId: string,
): Promise<void> {
  const key = normalizeAccountEmail(email);
  const [reservation] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, key))
    .for('update');
  if (!reservation) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  if (reservation.basisProjectionId !== projectionId) throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  const members = await transaction
    .select({ userId: authEmailReservationMembers.userId })
    .from(authEmailReservationMembers)
    .where(eq(authEmailReservationMembers.normalizedEmail, key))
    .limit(2);
  if (reservation.state === 'owned') {
    if (!key || reservation.ownerUserId !== userId || members.length !== 1 || members[0].userId !== userId)
      throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    return;
  }

  // A blocked collision/empty key still represents this exact authenticated
  // UID. Deleting it must neither release the key nor elect another member.
  // A collision can be down to this one member: deleted members leave the group.
  const [subjectMember] = await transaction
    .select({ userId: authEmailReservationMembers.userId })
    .from(authEmailReservationMembers)
    .where(and(eq(authEmailReservationMembers.normalizedEmail, key), eq(authEmailReservationMembers.userId, userId)))
    .limit(1);
  const representedBlockedKey =
    reservation.ownerUserId === null &&
    subjectMember !== undefined &&
    ((reservation.state === 'blocked_ambiguous' && key.length > 0) ||
      (reservation.state === 'blocked_invalid' && key.length === 0));
  if (!representedBlockedKey) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
}

/**
 * Call last, after the real users DELETE in the SAME outer transaction. Only
 * bookkeeping is left, so the short limits apply from here to commit. The gate
 * is already held, so re-validating the manifest never waits; a projection
 * changed by a writer that skipped the gate fails it and rolls everything back.
 * Then section 4's order for this climber: reservation, cutoff, event. Nothing
 * here waits on another climber's row, and no command holds this climber's
 * reservation while waiting for the users row this deletion holds, because every
 * command takes that row first.
 * This adds no recent-auth or legacy-validator revocation proof.
 */
export async function recordReservedAccountDeletion(
  transaction: CurrentStoreTransaction,
  command: CapturedAccountDeletionCommand,
  subject: ReservedDeletionSubject,
): Promise<void> {
  await transactionSettings(transaction);
  const manifest = await lockEnforcedProjection(transaction, command);
  await requireRepresentedDeletionEmail(transaction, command.userId, subject.email, manifest.projectionId);

  // Read each attempt's current generation here, under the deleted row's lock;
  // a rolled-back deadlock retry must not reuse a stale one.
  const [previous] = await transaction
    .select({ generation: authSubjectCutoffs.generation })
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, command.userId))
    .limit(1);
  await recordSecurityMutation(transaction, {
    ...command,
    expectedGeneration: previous?.generation ?? 0,
    kind: 'account-deletion',
    domains: ['first-party', 'partner'],
  });
  // The receipts carry the address they were sent to (decision 1, epic #6975).
  // Their purpose generations stay, so no old receipt snapshot can come back.
  await transaction.delete(authPasswordRecoveryTokens).where(eq(authPasswordRecoveryTokens.userId, command.userId));
  await transaction.delete(authEmailVerificationTokens).where(eq(authEmailVerificationTokens.userId, command.userId));
}
