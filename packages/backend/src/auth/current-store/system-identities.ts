import { accountEmailCandidates } from '@boardsesh/db/queries/account-email';
import { assertLegacyIdentityWriterAllowed } from './identity-writer-gate';
import { bindIdentityAuthority } from '../authority/identity-authority';
import { mirrorAuthorityToCurrentStore } from '../authority/reverse-identity';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityReceipt,
  type IdentityAuthorityQualification,
} from '../authority/router';
import { mirrorIdentityIfEnabled } from '../authority/sync-identity';
import {
  BATCH_SYSTEM_USERS,
  SYSTEM_BOARD_OWNER_ID,
  SYSTEM_BOARD_OWNER_EMAIL,
  SYSTEM_BOARD_OWNER_NAME,
} from '@boardsesh/db/queries/constants';
import {
  accounts,
  authAccount,
  authSession,
  authEmailReservationMembers,
  authEmailReservations,
  authSubjectCutoffs,
  mobileRefreshTokens,
  sessions,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { and, eq, ne, sql } from 'drizzle-orm';
import { lockFixedSystemOwnerTransaction } from '@boardsesh/db/fixed-system-owner-order';
import { normalizeAccountEmail } from '../normalize-email';
import { lockKeyReservation, reserveEnforcedEmail } from './email-reservations';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  lockEmailKeyForCreation,
  lockEnforcedProjection,
  lockSubjectRow,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

export type SystemIdentityKind = 'board-owner' | keyof typeof BATCH_SYSTEM_USERS;

const identities = {
  'board-owner': { id: SYSTEM_BOARD_OWNER_ID, email: SYSTEM_BOARD_OWNER_EMAIL, name: SYSTEM_BOARD_OWNER_NAME },
  ...BATCH_SYSTEM_USERS,
} as const;

/** Unexpected authentication history is rejected, including expired or revoked credentials. */
async function assertNoAuthenticationArtifacts(transaction: CurrentStoreTransaction, userId: string): Promise<void> {
  const [credential] = await transaction
    .select({ userId: userCredentials.userId })
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId))
    .limit(1);
  const [providerAccount] = await transaction
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .limit(1);
  const [session] = await transaction
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .limit(1);
  const [refresh] = await transaction
    .select({ userId: mobileRefreshTokens.userId })
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.userId, userId))
    .limit(1);
  const [canonicalAccount] = await transaction
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(eq(authAccount.userId, userId))
    .limit(1);
  const [canonicalSession] = await transaction
    .select({ id: authSession.id })
    .from(authSession)
    .where(eq(authSession.userId, userId))
    .limit(1);
  if (credential || providerAccount || session || refresh || canonicalAccount || canonicalSession)
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
}

/**
 * Fixed catalog only, in the caller's transaction. No history repair, credential,
 * verification, profile or session issuance. The caller owns timeouts and commit.
 * This prerequisite does not fence legacy writers or prevent system-UID sign-in.
 */
export async function ensureReservedSystemIdentity(
  transaction: CurrentStoreTransaction,
  authorityInput: ExpectedCurrentStoreAuthority,
  kind: SystemIdentityKind,
  selectedAuthority?: IdentityAuthorityReceipt,
): Promise<void> {
  const authority = captureExpectedAuthority(authorityInput);
  const receipt = selectedAuthority ? Object.freeze({ ...selectedAuthority }) : undefined;
  if (receipt) await revalidateIdentityAuthority(transaction, receipt);
  else await assertLegacyIdentityWriterAllowed(transaction);
  if (!Object.hasOwn(identities, kind)) throw new CurrentStoreFoundationError('INVALID_COMMAND');
  const { id: userId, email, name } = identities[kind];
  const key = normalizeAccountEmail(email);
  const manifest = await lockEnforcedProjection(transaction, authority);
  // Concurrent callers for this identity, and a registration naming its
  // address, queue here rather than one of them finding the fixed-owner key
  // busy: the gate no longer serializes them, and that key is never waited for.
  await lockEmailKeyForCreation(transaction, key);
  await lockFixedSystemOwnerTransaction(transaction);
  // The identity's own row first, before its cutoff and reservation: section 4's
  // lock order, which a forgot-password naming this address takes too.
  // FOR UPDATE, not NO KEY UPDATE: conflicting with FK KEY SHARE is the point.
  // It waits out an uncommitted credential, session or refresh-token insert for
  // this UID, so the artifact check below cannot miss one that is in flight.
  // The wait is short because this holds the exclusive fixed-owner key, which
  // content writers try once and report busy; an unavailable reply is safe. It
  // stays in force to commit, and nothing after this waits on another climber.
  await transaction.execute(sql`SET LOCAL lock_timeout = '250ms'`);
  const user = await lockSubjectRow(transaction, userId);
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  if (cutoff?.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
  const reservation = await lockKeyReservation(transaction, key);
  const [otherReservation] = await transaction
    .select({ normalizedEmail: authEmailReservations.normalizedEmail })
    .from(authEmailReservations)
    .where(and(eq(authEmailReservations.ownerUserId, userId), ne(authEmailReservations.normalizedEmail, key)))
    .limit(1)
    .for('update');
  const [otherMembership] = await transaction
    .select({ normalizedEmail: authEmailReservationMembers.normalizedEmail })
    .from(authEmailReservationMembers)
    .where(and(eq(authEmailReservationMembers.userId, userId), ne(authEmailReservationMembers.normalizedEmail, key)))
    .limit(1);
  if (otherReservation || otherMembership) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  await assertNoAuthenticationArtifacts(transaction, userId);

  if (user) {
    if (
      normalizeAccountEmail(user.email) !== key ||
      !reservation ||
      reservation.basisProjectionId !== manifest.projectionId ||
      reservation.state !== 'owned' ||
      reservation.ownerUserId !== userId
    )
      throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    const members = await transaction
      .select({ userId: authEmailReservationMembers.userId })
      .from(authEmailReservationMembers)
      .where(eq(authEmailReservationMembers.normalizedEmail, key))
      .limit(2);
    if (members.length !== 1 || members[0].userId !== userId)
      throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    if (receipt) await revalidateIdentityAuthority(transaction, receipt);
    return;
  }

  // Neither a retained reservation nor subject history permits resurrection.
  if (reservation || cutoff) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  const [existingEmail] = await transaction
    .select({ userId: users.id })
    .from(users)
    .where(accountEmailCandidates(email))
    .limit(1);
  if (existingEmail) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  await reserveEnforcedEmail(transaction, {
    ...authority,
    rawEmail: email,
    requestedUserId: userId,
  });
  if (receipt) {
    const created = await bindIdentityAuthority(transaction, receipt).createUser({ id: userId, email, name });
    if (created.id !== userId) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  } else {
    const [created] = await transaction
      .insert(users)
      .values({ id: userId, email, name })
      .returning({ userId: users.id });
    if (created?.userId !== userId) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  }
  if (receipt?.authority === 'better-auth') await mirrorAuthorityToCurrentStore(transaction, userId);
  else await mirrorIdentityIfEnabled(transaction, userId);
  if (receipt) await revalidateIdentityAuthority(transaction, receipt);
}

/** Actual staged commands select a fresh writer receipt inside their existing transaction. */
export async function ensureSelectedSystemIdentity(
  transaction: CurrentStoreTransaction,
  qualificationInput: IdentityAuthorityQualification,
  kind: SystemIdentityKind,
): Promise<void> {
  const qualification = { ...qualificationInput };
  const receipt = await captureIdentityAuthority(transaction, qualification);
  await ensureReservedSystemIdentity(
    transaction,
    {
      expectedProjectionId: receipt.projectionId,
      expectedNormalizerVersion: receipt.normalizerVersion,
      expectedWriterEpoch: receipt.epoch,
    },
    kind,
    receipt,
  );
}
