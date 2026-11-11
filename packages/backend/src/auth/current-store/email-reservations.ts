import { createHmac } from 'node:crypto';
import type { DbInstance } from '@boardsesh/db/client';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { and, eq, inArray, like, lt, sql } from 'drizzle-orm';
import { normalizeAccountEmail } from '../normalize-email';
import { currentStoreDeletedEmailKey } from './authority-configuration';
import { transactionSettings } from './command-context';
import {
  captureExpectedAuthority,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  CurrentStoreFoundationError,
  lockEmailKeyForCreation,
  lockEnforcedProjection,
  requireReadCommitted,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

const RETIRED_EMAIL_KEY_PREFIX = 'deleted-v1:';
/** How long a deleted account's address stays blocked (decision 1, epic #6975). */
export const RETIRED_EMAIL_DAYS = 90;
const RETIRED_EMAIL_PURGE_BATCH = 1_000;

/**
 * The reservation key a deleted account's address leaves behind: an HMAC of the
 * normalized address, never the address itself. Lookups compute it again from
 * the address being registered, so the block holds without storing what it blocks.
 */
export function retiredEmailKey(normalizedEmail: string): string {
  const digest = createHmac('sha256', currentStoreDeletedEmailKey())
    .update(`deleted-email-v1\0${normalizedEmail}`)
    .digest('hex');
  return `${RETIRED_EMAIL_KEY_PREFIX}${digest}`;
}

/**
 * The reservation that decides whether `key` can be taken: its own row, or else
 * the digest row a deleted account left for it. Locked; callers hold the manifest.
 */
export async function lockKeyReservation(transaction: CurrentStoreTransaction, key: string) {
  const [reservation] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, key))
    .for('update');
  if (reservation || !key) return reservation;
  const [retired] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, retiredEmailKey(key)))
    .for('update');
  return retired;
}

/**
 * What a deleted account leaves of its addresses, in the deletion's own
 * transaction under the manifest. Its memberships go. A key it alone held
 * becomes a digest row, so the address stays blocked without being kept; a
 * group it shared keeps its other members, still blocked, and elects nobody.
 * The empty key holds no address and is left alone.
 */
export async function retireDeletedSubjectEmails(transaction: CurrentStoreTransaction, userId: string): Promise<void> {
  const memberships = await transaction
    .select({ normalizedEmail: authEmailReservationMembers.normalizedEmail })
    .from(authEmailReservationMembers)
    .where(eq(authEmailReservationMembers.userId, userId));
  const owned = await transaction
    .select({ normalizedEmail: authEmailReservations.normalizedEmail })
    .from(authEmailReservations)
    .where(and(eq(authEmailReservations.ownerUserId, userId), eq(authEmailReservations.state, 'owned')));
  const keys = [...new Set([...memberships, ...owned].map(({ normalizedEmail }) => normalizedEmail))]
    .filter((key) => key.length > 0)
    .sort();
  for (const key of keys) {
    const [reservation] = await transaction
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, key))
      .for('update');
    if (!reservation) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    await transaction
      .delete(authEmailReservationMembers)
      .where(and(eq(authEmailReservationMembers.normalizedEmail, key), eq(authEmailReservationMembers.userId, userId)));
    const [remaining] = await transaction
      .select({ userId: authEmailReservationMembers.userId })
      .from(authEmailReservationMembers)
      .where(eq(authEmailReservationMembers.normalizedEmail, key))
      .limit(1);
    if (reservation.state === 'owned') {
      if (reservation.ownerUserId !== userId || remaining)
        throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    } else if (remaining) continue;
    await transaction.delete(authEmailReservations).where(eq(authEmailReservations.normalizedEmail, key));
    await transaction
      .insert(authEmailReservations)
      .values({
        normalizedEmail: retiredEmailKey(key),
        basisProjectionId: reservation.basisProjectionId,
        state: 'blocked_deleted',
        ownerUserId: null,
        createdAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: authEmailReservations.normalizedEmail,
        set: { createdAt: sql`greatest(${authEmailReservations.createdAt}, excluded.created_at)` },
      });
  }
}

/**
 * Removes deleted-address digests older than {@link RETIRED_EMAIL_DAYS}, one
 * bounded batch a run; a backlog drains over later runs. Digest rows never have
 * members, so nothing else references them.
 */
export async function purgeRetiredEmailKeys(
  database: DbInstance,
  batchSize: number = RETIRED_EMAIL_PURGE_BATCH,
): Promise<number> {
  return database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const expired = await transaction
      .select({ normalizedEmail: authEmailReservations.normalizedEmail })
      .from(authEmailReservations)
      .where(
        and(
          like(authEmailReservations.normalizedEmail, `${RETIRED_EMAIL_KEY_PREFIX}%`),
          eq(authEmailReservations.state, 'blocked_deleted'),
          lt(
            authEmailReservations.createdAt,
            sql`clock_timestamp() - make_interval(days => ${RETIRED_EMAIL_DAYS}::int)`,
          ),
        ),
      )
      .limit(batchSize)
      .for('update', { skipLocked: true });
    if (expired.length === 0) return 0;
    await transaction.delete(authEmailReservations).where(
      inArray(
        authEmailReservations.normalizedEmail,
        expired.map(({ normalizedEmail }) => normalizedEmail),
      ),
    );
    return expired.length;
  });
}

/**
 * One-time preparation only. The real table lock gives a consistent snapshot,
 * not exclusion of old writers after commit. Production cutover is unimplemented.
 */
export async function prepareProjectionUnderUsersTableLock(
  transaction: CurrentStoreTransaction,
  options: { readonly projectionId: string },
) {
  const projectionId = options.projectionId;
  if (!projectionId || projectionId !== projectionId.trim()) throw new CurrentStoreFoundationError('INVALID_COMMAND');
  // A table lock cannot refresh an earlier REPEATABLE READ/SERIALIZABLE
  // snapshot. READ COMMITTED gives the locked SELECT a fresh view of old writes.
  await requireReadCommitted(transaction);
  const [previousManifest] = await transaction
    .select({ projectionId: authEmailProjection.projectionId })
    .from(authEmailProjection)
    .limit(1);
  if (previousManifest) throw new CurrentStoreFoundationError('PROJECTION_EXISTS');
  const inserted = await transaction
    .insert(authEmailProjection)
    .values({
      projectionId,
      isCurrent: true,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      phase: 'preparing',
      writerEpoch: 1,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length !== 1) throw new CurrentStoreFoundationError('PROJECTION_EXISTS');
  // SQL is necessary for an actual table write lock; an advisory lock would
  // only serialize callers that voluntarily acquire that advisory lock.
  await transaction.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
  const identities = await transaction.select({ userId: users.id, email: users.email }).from(users).orderBy(users.id);
  const groups = new Map<string, string[]>();
  for (const identity of identities) {
    const key = normalizeAccountEmail(identity.email);
    const owners = groups.get(key) ?? [];
    owners.push(identity.userId);
    groups.set(key, owners);
  }
  let ambiguousKeyCount = 0;
  for (const [normalizedEmail, owners] of groups) {
    if (owners.length > 1) ambiguousKeyCount += 1;
    const state =
      normalizedEmail.length === 0 ? 'blocked_invalid' : owners.length === 1 ? 'owned' : 'blocked_ambiguous';
    await transaction.insert(authEmailReservations).values({
      normalizedEmail,
      basisProjectionId: projectionId,
      state,
      ownerUserId: state === 'owned' ? owners[0] : null,
    });
    await transaction.insert(authEmailReservationMembers).values(owners.map((userId) => ({ normalizedEmail, userId })));
  }
  const [prepared] = await transaction
    .update(authEmailProjection)
    .set({
      phase: 'prepared',
      sourceUserCount: identities.length,
      keyCount: groups.size,
      ambiguousKeyCount,
      preparedAt: sql`clock_timestamp()`,
    })
    .where(eq(authEmailProjection.projectionId, projectionId))
    .returning();
  if (!prepared) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  return prepared;
}

/** Only a trusted service may supply the freshly generated or proven owner ID. */
export async function reserveEnforcedEmail(
  transaction: CurrentStoreTransaction,
  options: ExpectedCurrentStoreAuthority & {
    readonly rawEmail: string;
    readonly requestedUserId: string;
  },
) {
  const expected = captureExpectedAuthority(options);
  const normalizedEmail = normalizeAccountEmail(options.rawEmail);
  const requestedUserId = options.requestedUserId;
  if (!normalizedEmail || !requestedUserId || requestedUserId !== requestedUserId.trim())
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  const manifest = await lockEnforcedProjection(transaction, expected);
  // Every caller takes this before reading the reservation; taking it again here
  // is free and keeps a new reservation row from ever being written without it.
  await lockEmailKeyForCreation(transaction, normalizedEmail);
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, requestedUserId))
    .for('update');
  if (cutoff?.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
  const existing = await lockKeyReservation(transaction, normalizedEmail);
  if (!existing) {
    await transaction.insert(authEmailReservations).values({
      normalizedEmail,
      basisProjectionId: manifest.projectionId,
      state: 'owned',
      ownerUserId: requestedUserId,
    });
    await transaction.insert(authEmailReservationMembers).values({ normalizedEmail, userId: requestedUserId });
  } else {
    if (existing.basisProjectionId !== manifest.projectionId) throw new CurrentStoreFoundationError('STALE_AUTHORITY');
    if (existing.state === 'blocked_ambiguous') throw new CurrentStoreFoundationError('EMAIL_AMBIGUOUS');
    if (existing.state === 'blocked_deleted') throw new CurrentStoreFoundationError('EMAIL_RETIRED');
    if (existing.state === 'blocked_invalid') throw new CurrentStoreFoundationError('EMAIL_INVALID');
    if (existing.ownerUserId !== requestedUserId) throw new CurrentStoreFoundationError('EMAIL_RESERVED');
    const members = await transaction
      .select()
      .from(authEmailReservationMembers)
      .where(eq(authEmailReservationMembers.normalizedEmail, normalizedEmail));
    if (members.length !== 1 || members[0].userId !== requestedUserId)
      throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  }
  return { normalizedEmail, ownerUserId: requestedUserId, basisProjectionId: manifest.projectionId };
}
