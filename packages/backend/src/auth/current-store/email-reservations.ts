import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { eq, sql } from 'drizzle-orm';
import { normalizeAccountEmail } from '../normalize-email';
import {
  captureExpectedAuthority,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  requireReadCommitted,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

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
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, requestedUserId))
    .for('update');
  if (cutoff?.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
  const [existing] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, normalizedEmail))
    .for('update');
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
