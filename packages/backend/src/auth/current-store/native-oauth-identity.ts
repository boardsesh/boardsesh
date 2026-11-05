import { randomUUID } from 'node:crypto';
import {
  accounts,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  users,
  userProfiles,
} from '@boardsesh/db/schema/auth';
import { and, eq } from 'drizzle-orm';
import { normalizeAccountEmail } from '../normalize-email';
import { parseCurrentStoreRegistrationEmail } from './password-identity';
import { reserveEnforcedEmail } from './email-reservations';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';

export type NativeOAuthProvider = 'apple' | 'google';
export interface VerifiedNativeOAuthIdentity {
  readonly sub: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
}
export interface NativeOAuthForwardedName {
  readonly firstName?: string;
  readonly lastName?: string;
}
export type ReservedNativeOAuthIdentity =
  | { outcome: 'linked'; userId: string; createdAt: Date }
  | { outcome: 'created'; userId: string; createdAt: Date }
  | { outcome: 'conflict' }
  | { outcome: 'no_email' }
  | { outcome: 'deleted' };

export function resolveNativeOAuthDisplayName(
  identity: VerifiedNativeOAuthIdentity,
  forwardedName: NativeOAuthForwardedName | undefined,
): string | null {
  if (forwardedName) {
    const parts = [forwardedName.firstName, forwardedName.lastName].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    if (parts.length > 0) return parts.join(' ').trim();
  }
  return identity.name;
}

/** Caller supplies backend-verified claims, owns this tx and uses the same issuer. */
export async function resolveReservedNativeOAuthIdentity(
  transaction: CurrentStoreTransaction,
  authorityInput: ExpectedCurrentStoreAuthority,
  provider: NativeOAuthProvider,
  identityInput: VerifiedNativeOAuthIdentity,
  forwardedNameInput?: NativeOAuthForwardedName,
): Promise<ReservedNativeOAuthIdentity> {
  const authority = captureExpectedAuthority(authorityInput);
  const identity = { ...identityInput };
  const forwardedName = forwardedNameInput ? { ...forwardedNameInput } : undefined;
  const manifest = await lockEnforcedProjection(transaction, authority);
  const predicate = and(eq(accounts.provider, provider), eq(accounts.providerAccountId, identity.sub));
  // Read accounts directly: a dangling or disappearing link is not a new login.
  const [initialLink] = await transaction.select({ userId: accounts.userId }).from(accounts).where(predicate);
  if (initialLink) {
    const userId = initialLink.userId;
    const [initialUser] = await transaction.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const [user] = await transaction.select().from(users).where(eq(users.id, userId)).for('update');
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
    return { outcome: 'linked', userId, createdAt: new Date(user.createdAt.getTime()) };
  }
  const parsedEmail = parseCurrentStoreRegistrationEmail(identity.email);
  if (!parsedEmail.ok) return { outcome: 'no_email' };
  const email = parsedEmail.email;
  const [reservation] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, email))
    .for('update');
  if (reservation) {
    if (reservation.basisProjectionId !== manifest.projectionId)
      throw new CurrentStoreFoundationError('STALE_AUTHORITY');
    return { outcome: 'conflict' };
  }
  const [existing] = await transaction.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  const userId = randomUUID();
  await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
  const createdAt = new Date();
  await transaction.insert(users).values({
    id: userId,
    createdAt,
    email,
    name: resolveNativeOAuthDisplayName(identity, forwardedName),
    emailVerified: identity.emailVerified ? new Date() : null,
  });
  await transaction.insert(userProfiles).values({ userId }).onConflictDoNothing();
  // A legacy writer can race the absent row. A unique failure aborts ALL writes;
  // never ignore it and mint a credential for an unconfirmed provider owner.
  const [inserted] = await transaction
    .insert(accounts)
    .values({ userId, type: 'oauth', provider, providerAccountId: identity.sub })
    .returning({ userId: accounts.userId });
  if (!inserted || inserted.userId !== userId) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  return { outcome: 'created', userId, createdAt };
}
