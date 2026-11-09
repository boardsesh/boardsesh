import {
  authEmailReservationMembers,
  authEmailReservations,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { and, eq } from 'drizzle-orm';
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

/** Enter manifest then fixed-owner key before content; keep human subject/user locks after walls. */
export async function beginReservedAccountDeletion(
  transaction: CurrentStoreTransaction,
  command: CapturedAccountDeletionCommand,
): Promise<void> {
  await transactionSettings(transaction);
  await lockEnforcedProjection(transaction, command);
  await lockSharedFixedSystemOwnerTransaction(transaction);
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
  const [subjectMember] = await transaction
    .select({ userId: authEmailReservationMembers.userId })
    .from(authEmailReservationMembers)
    .where(and(eq(authEmailReservationMembers.normalizedEmail, key), eq(authEmailReservationMembers.userId, userId)))
    .limit(1);
  const representedBlockedKey =
    reservation.ownerUserId === null &&
    subjectMember !== undefined &&
    ((reservation.state === 'blocked_ambiguous' && key.length > 0 && members.length === 2) ||
      (reservation.state === 'blocked_invalid' && key.length === 0));
  if (!representedBlockedKey) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
}

/**
 * Call immediately before the real users DELETE in the SAME outer transaction,
 * after existing account/wall/content work has acquired its late user lock.
 * This adds no recent-auth or legacy-validator revocation proof.
 */
export async function recordReservedAccountDeletion(
  transaction: CurrentStoreTransaction,
  command: CapturedAccountDeletionCommand,
): Promise<void> {
  const manifest = await lockEnforcedProjection(transaction, command);
  // Re-entrant for the mounted deletion path. Keeping this check late preserves
  // wall -> users ordering and never invents a tombstone for an absent subject.
  const [subject] = await transaction
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, command.userId))
    .limit(1)
    .for('update');
  if (!subject) throw new CurrentStoreFoundationError('INVALID_COMMAND');
  await requireRepresentedDeletionEmail(transaction, command.userId, subject.email, manifest.projectionId);

  // The manifest serializes cooperating writers. Read each attempt's current
  // generation here; a rolled-back deadlock retry must not reuse a stale one.
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
}
