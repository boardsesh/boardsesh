import { randomUUID } from 'node:crypto';
import {
  accounts,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  users,
  userProfiles,
} from '@boardsesh/db/schema/auth';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccountEmail } from '../normalize-email';
import { parseCurrentStoreRegistrationEmail } from './password-identity';
import { lockKeyReservation, reserveEnforcedEmail } from './email-reservations';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  lockEmailKeyForCreation,
  lockEnforcedProjection,
  lockProviderSubject,
  lockSubjectRow,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

export type CurrentStoreOAuthProvider = 'apple' | 'google' | 'facebook';
export interface VerifiedCurrentStoreOAuthIdentity {
  readonly sub: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly image?: string | null;
}
export interface CurrentStoreOAuthForwardedName {
  readonly firstName?: string;
  readonly lastName?: string;
}
export type ReservedCurrentStoreOAuthIdentity =
  | { outcome: 'linked'; user: typeof users.$inferSelect }
  | { outcome: 'created'; user: typeof users.$inferSelect }
  | { outcome: 'conflict' }
  | { outcome: 'no_email' }
  | { outcome: 'deleted' }
  | { outcome: 'actor_conflict' }
  | { outcome: 'sensitive_link_unavailable' };

export interface CurrentStoreOAuthCreationPolicy {
  readonly emailStorage: 'normalized' | 'provided';
  readonly emailVerification: 'provider' | 'unverified';
  /** Verified negative browser binding only; never a fresh-login assertion. */
  readonly actorUserId: string | null;
}

export function resolveCurrentStoreOAuthDisplayName(
  identity: VerifiedCurrentStoreOAuthIdentity,
  forwardedName: CurrentStoreOAuthForwardedName | undefined,
): string | null {
  if (forwardedName) {
    const parts = [forwardedName.firstName, forwardedName.lastName].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    if (parts.length > 0) return parts.join(' ').trim();
  }
  return identity.name;
}

/**
 * Native supplies backend-verified claims; web supplies assertions from its
 * authenticated provider-verifying delegate. Caller owns this transaction;
 * this helper issues no credential.
 */
export async function resolveReservedCurrentStoreOAuthIdentity(
  transaction: CurrentStoreTransaction,
  authorityInput: ExpectedCurrentStoreAuthority,
  provider: CurrentStoreOAuthProvider,
  identityInput: VerifiedCurrentStoreOAuthIdentity,
  policyInput: CurrentStoreOAuthCreationPolicy,
  forwardedNameInput?: CurrentStoreOAuthForwardedName,
): Promise<ReservedCurrentStoreOAuthIdentity> {
  const authority = captureExpectedAuthority(authorityInput);
  const identity = { ...identityInput };
  const policy = { ...policyInput };
  const forwardedName = forwardedNameInput ? { ...forwardedNameInput } : undefined;
  const manifest = await lockEnforcedProjection(transaction, authority);
  // One sign-in per provider subject at a time, before its link is read: the
  // gate no longer serializes commands (section 4). Linked: the subject, then the
  // owner's users row, then their reservation. New: the subject, then the key.
  await lockProviderSubject(transaction, provider, identity.sub);
  const predicate = and(eq(accounts.provider, provider), eq(accounts.providerAccountId, identity.sub));
  // Read accounts directly: a dangling or disappearing link is not a new login.
  const [initialLink] = await transaction.select({ userId: accounts.userId }).from(accounts).where(predicate);
  if (initialLink) {
    const userId = initialLink.userId;
    if (policy.actorUserId !== null && policy.actorUserId !== userId) return { outcome: 'actor_conflict' };
    const [initialUser] = await transaction.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const user = await lockSubjectRow(transaction, userId);
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId))
      .for('update');
    if (cutoff?.deletedAt) return { outcome: 'deleted' };
    if (!initialUser || !user || normalizeAccountEmail(initialUser.email) !== normalizeAccountEmail(user.email))
      throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    const [link] = await transaction.select({ userId: accounts.userId }).from(accounts).where(predicate).for('update');
    if (!link || link.userId !== userId) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    const key = normalizeAccountEmail(user.email);
    const [reservation] = await transaction
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, key))
      .for('update');
    if (!reservation || reservation.basisProjectionId !== manifest.projectionId)
      throw new CurrentStoreFoundationError('STALE_AUTHORITY');
    if (reservation.state === 'owned') {
      const members = await transaction
        .select({ userId: authEmailReservationMembers.userId })
        .from(authEmailReservationMembers)
        .where(eq(authEmailReservationMembers.normalizedEmail, key))
        .limit(2);
      if (reservation.ownerUserId !== userId || members.length !== 1 || members[0].userId !== userId)
        throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    } else if (reservation.state === 'blocked_ambiguous') {
      const [member] = await transaction
        .select({ userId: authEmailReservationMembers.userId })
        .from(authEmailReservationMembers)
        .where(
          and(eq(authEmailReservationMembers.normalizedEmail, key), eq(authEmailReservationMembers.userId, userId)),
        );
      if (!member) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    } else throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    // Changed/missing provider email and name never rewrite a returning owner.
    return { outcome: 'linked', user };
  }
  if (policy.actorUserId !== null) return { outcome: 'sensitive_link_unavailable' };
  const parsedEmail = parseCurrentStoreRegistrationEmail(identity.email);
  if (!parsedEmail.ok) return { outcome: 'no_email' };
  const key = parsedEmail.email;
  const email = policy.emailStorage === 'provided' ? identity.email! : key;
  await lockEmailKeyForCreation(transaction, key);
  // A deleted account's address conflicts like a taken one until its digest expires.
  const reservation = await lockKeyReservation(transaction, key);
  if (reservation) {
    if (reservation.basisProjectionId !== manifest.projectionId)
      throw new CurrentStoreFoundationError('STALE_AUTHORITY');
    return { outcome: 'conflict' };
  }
  // Normalized, as login matches: another case of this mailbox is the same owner.
  const [existing] = await transaction
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.email}) = ${key}`)
    .limit(1);
  if (existing) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  const userId = randomUUID();
  await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
  const createdAt = new Date();
  const [created] = await transaction
    .insert(users)
    .values({
      id: userId,
      createdAt,
      email,
      name: resolveCurrentStoreOAuthDisplayName(identity, forwardedName),
      emailVerified: policy.emailVerification === 'provider' && identity.emailVerified ? new Date() : null,
      ...(policy.emailStorage === 'provided' ? { image: identity.image ?? null } : {}),
    })
    .returning();
  if (!created) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  await transaction.insert(userProfiles).values({ userId }).onConflictDoNothing();
  // A legacy writer can race the absent row. A unique failure aborts ALL writes;
  // never ignore it and mint a credential for an unconfirmed provider owner.
  const [inserted] = await transaction
    .insert(accounts)
    .values({ userId, type: 'oauth', provider, providerAccountId: identity.sub })
    .returning({ userId: accounts.userId });
  if (!inserted || inserted.userId !== userId) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  return { outcome: 'created', user: created };
}
