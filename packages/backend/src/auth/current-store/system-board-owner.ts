import type { DbInstance } from '@boardsesh/db/client';
import {
  SYSTEM_BOARD_OWNER_ID,
  SYSTEM_BOARD_OWNER_EMAIL,
  SYSTEM_BOARD_OWNER_NAME,
} from '@boardsesh/db/queries/constants';
import {
  accounts,
  authEmailReservationMembers,
  authEmailReservations,
  authSubjectCutoffs,
  mobileRefreshTokens,
  sessions,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { and, eq, ne } from 'drizzle-orm';
import { normalizeAccountEmail } from '../normalize-email';
import { transactionSettings } from './command-context';
import { reserveEnforcedEmail } from './email-reservations';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

/** Unexpected authentication history is rejected, including expired or revoked credentials. */
async function assertNoAuthenticationArtifacts(transaction: CurrentStoreTransaction): Promise<void> {
  const [credential] = await transaction
    .select({ userId: userCredentials.userId })
    .from(userCredentials)
    .where(eq(userCredentials.userId, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  const [providerAccount] = await transaction
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.userId, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  const [session] = await transaction
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.userId, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  const [refresh] = await transaction
    .select({ userId: mobileRefreshTokens.userId })
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.userId, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  if (credential || providerAccount || session || refresh)
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
}

/**
 * Owns only the fixed board identity and its normalized reservation. This does
 * not fence legacy writers or prevent other issuers authenticating a system UID.
 * No profile, credential, verification, session or security generation is created.
 */
export async function ensureReservedSystemBoardOwner(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
): Promise<void> {
  const authority = captureExpectedAuthority(authorityInput);
  const key = normalizeAccountEmail(SYSTEM_BOARD_OWNER_EMAIL);
  await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const manifest = await lockEnforcedProjection(transaction, authority);
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, SYSTEM_BOARD_OWNER_ID))
      .for('update');
    if (cutoff?.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
    const [reservation] = await transaction
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, key))
      .for('update');
    const [otherReservation] = await transaction
      .select({ normalizedEmail: authEmailReservations.normalizedEmail })
      .from(authEmailReservations)
      .where(
        and(
          eq(authEmailReservations.ownerUserId, SYSTEM_BOARD_OWNER_ID),
          ne(authEmailReservations.normalizedEmail, key),
        ),
      )
      .limit(1)
      .for('update');
    const [otherMembership] = await transaction
      .select({ normalizedEmail: authEmailReservationMembers.normalizedEmail })
      .from(authEmailReservationMembers)
      .where(
        and(
          eq(authEmailReservationMembers.userId, SYSTEM_BOARD_OWNER_ID),
          ne(authEmailReservationMembers.normalizedEmail, key),
        ),
      )
      .limit(1);
    if (otherReservation || otherMembership) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    const [user] = await transaction.select().from(users).where(eq(users.id, SYSTEM_BOARD_OWNER_ID)).for('update');
    await assertNoAuthenticationArtifacts(transaction);

    if (user) {
      if (
        normalizeAccountEmail(user.email) !== key ||
        !reservation ||
        reservation.basisProjectionId !== manifest.projectionId ||
        reservation.state !== 'owned' ||
        reservation.ownerUserId !== SYSTEM_BOARD_OWNER_ID
      )
        throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
      const members = await transaction
        .select({ userId: authEmailReservationMembers.userId })
        .from(authEmailReservationMembers)
        .where(eq(authEmailReservationMembers.normalizedEmail, key))
        .limit(2);
      if (members.length !== 1 || members[0].userId !== SYSTEM_BOARD_OWNER_ID)
        throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
      return;
    }

    // Neither a retained reservation nor subject history permits resurrection.
    if (reservation || cutoff) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    const [existingEmail] = await transaction
      .select({ userId: users.id })
      .from(users)
      .where(eq(users.email, SYSTEM_BOARD_OWNER_EMAIL))
      .limit(1);
    if (existingEmail) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    await reserveEnforcedEmail(transaction, {
      ...authority,
      rawEmail: SYSTEM_BOARD_OWNER_EMAIL,
      requestedUserId: SYSTEM_BOARD_OWNER_ID,
    });
    const [created] = await transaction
      .insert(users)
      .values({ id: SYSTEM_BOARD_OWNER_ID, email: SYSTEM_BOARD_OWNER_EMAIL, name: SYSTEM_BOARD_OWNER_NAME })
      .returning({ userId: users.id });
    if (created?.userId !== SYSTEM_BOARD_OWNER_ID) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  });
}
