import { mirrorIdentityIfEnabled } from '../authority/sync-identity';
import { mirrorAuthorityToCurrentStore } from '../authority/reverse-identity';
import { bindIdentityAuthority } from '../authority/identity-authority';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityReceipt,
} from '../authority/router';
import { randomUUID } from 'node:crypto';
import { executeFirstRow } from '@boardsesh/db/client';
import type { ProviderIdentityPlan } from '@boardsesh/auth-protocol';
import {
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

export type CurrentStoreOAuthProvider = 'apple' | 'google';
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

export type CurrentStoreOAuthIdentityPlan = ProviderIdentityPlan;
export type PlannedCurrentStoreOAuthIdentity =
  | { readonly outcome: 'planned'; readonly plan: CurrentStoreOAuthIdentityPlan }
  | Exclude<ReservedCurrentStoreOAuthIdentity, { outcome: 'linked' | 'created' }>;
type OAuthIdentityMode =
  | { readonly kind: 'write' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'apply'; readonly plan: CurrentStoreOAuthIdentityPlan };

function freezeOAuthIdentityPlan(plan: CurrentStoreOAuthIdentityPlan): CurrentStoreOAuthIdentityPlan {
  return Object.freeze({ ...plan, user: Object.freeze({ ...plan.user }) });
}
function existingOAuthIdentityPlan(
  provider: CurrentStoreOAuthProvider,
  subject: string,
  generation: number,
  user: typeof users.$inferSelect,
): CurrentStoreOAuthIdentityPlan {
  return freezeOAuthIdentityPlan({
    kind: 'existing',
    provider,
    subject,
    generation,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      emailVerified: user.emailVerified?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    },
  });
}
function requireSameOAuthIdentityPlan(
  expected: CurrentStoreOAuthIdentityPlan,
  observed: CurrentStoreOAuthIdentityPlan,
): void {
  if (
    expected.kind !== observed.kind ||
    expected.provider !== observed.provider ||
    expected.subject !== observed.subject ||
    expected.generation !== observed.generation ||
    expected.user.id !== observed.user.id ||
    expected.user.email !== observed.user.email ||
    expected.user.name !== observed.user.name ||
    expected.user.image !== observed.user.image ||
    expected.user.emailVerified !== observed.user.emailVerified ||
    expected.user.createdAt !== observed.user.createdAt
  )
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
}

async function readOAuthPlanningClock(transaction: CurrentStoreTransaction): Promise<Date> {
  const clock = await executeFirstRow<{ now: string | Date }>(transaction, sql`SELECT clock_timestamp() AS now`);
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) throw new CurrentStoreFoundationError('INVALID_COMMAND');
  return now;
}

export interface CurrentStoreOAuthCreationPolicy {
  /** Web keeps the provider's avatar on a new account; native never had one. */
  readonly storeProviderImage: boolean;
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
async function resolveReservedCurrentStoreOAuthIdentityInTransaction(
  transaction: CurrentStoreTransaction,
  authorityInput: ExpectedCurrentStoreAuthority,
  provider: CurrentStoreOAuthProvider,
  identityInput: VerifiedCurrentStoreOAuthIdentity,
  policyInput: CurrentStoreOAuthCreationPolicy,
  forwardedNameInput: CurrentStoreOAuthForwardedName | undefined,
  receiptInput: IdentityAuthorityReceipt | undefined,
  requestedMode: OAuthIdentityMode,
): Promise<
  ReservedCurrentStoreOAuthIdentity | { readonly outcome: 'planned'; readonly plan: CurrentStoreOAuthIdentityPlan }
> {
  if (provider !== 'google' && provider !== 'apple') throw new CurrentStoreFoundationError('INVALID_COMMAND');
  const authority = captureExpectedAuthority(authorityInput);
  const identity = { ...identityInput };
  const policy = { ...policyInput };
  const forwardedName = forwardedNameInput ? { ...forwardedNameInput } : undefined;
  const suppliedReceipt = receiptInput ? Object.freeze({ ...receiptInput }) : undefined;
  const mode =
    requestedMode.kind === 'apply'
      ? { kind: 'apply' as const, plan: freezeOAuthIdentityPlan(requestedMode.plan) }
      : requestedMode;
  const manifest = await lockEnforcedProjection(transaction, authority);
  const receipt = suppliedReceipt ?? (await captureIdentityAuthority(transaction, authority));
  await revalidateIdentityAuthority(transaction, receipt);
  const storage = bindIdentityAuthority(transaction, receipt);
  async function mirror(userId: string) {
    if (receipt.authority === 'better-auth') await mirrorAuthorityToCurrentStore(transaction, userId);
    else await mirrorIdentityIfEnabled(transaction, userId);
    await revalidateIdentityAuthority(transaction, receipt);
  }
  // One sign-in per provider subject at a time, before its link is read: the
  // gate no longer serializes commands (section 4). Linked: the subject, then the
  // owner's users row, then their reservation. New: the subject, then the key.
  await lockProviderSubject(transaction, provider, identity.sub);
  // Read only the selected authority. A dangling or disappearing link is never
  // permission to create a replacement identity through the other store.
  const initialLink = await storage.findProvider(provider, identity.sub);
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
    const link = await storage.findProvider(provider, identity.sub, 'update');
    if (!link || link.userId !== userId) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    if (initialLink.generation !== (cutoff?.generation ?? 0) || link.generation !== initialLink.generation)
      throw new CurrentStoreFoundationError('STALE_GENERATION');
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
    const planned = existingOAuthIdentityPlan(provider, identity.sub, initialLink.generation, user);
    if (mode.kind === 'plan') return { outcome: 'planned', plan: planned };
    if (mode.kind === 'apply') requireSameOAuthIdentityPlan(mode.plan, planned);
    // Changed/missing provider email and name never rewrite a returning owner.
    await mirror(userId);
    return { outcome: 'linked', user };
  }
  if (policy.actorUserId !== null) return { outcome: 'sensitive_link_unavailable' };
  const parsedEmail = parseCurrentStoreRegistrationEmail(identity.email);
  if (!parsedEmail.ok) return { outcome: 'no_email' };
  // Every new account stores the normalized form (BA-02), so the planned
  // unique index on lower(email) and Better Auth's exact lookup both find it.
  const key = parsedEmail.email;
  const email = key;
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
  if (mode.kind === 'apply' && mode.plan.kind !== 'new')
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  const userId = mode.kind === 'apply' ? mode.plan.user.id : randomUUID();
  const createdAt =
    mode.kind === 'apply'
      ? new Date(mode.plan.user.createdAt)
      : mode.kind === 'plan'
        ? await readOAuthPlanningClock(transaction)
        : new Date();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(userId) ||
    !Number.isFinite(createdAt.getTime()) ||
    (mode.kind === 'apply' && createdAt.toISOString() !== mode.plan.user.createdAt)
  )
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  const emailVerified =
    policy.emailVerification === 'provider' && identity.emailVerified
      ? mode.kind === 'write'
        ? new Date()
        : createdAt
      : null;
  const planned = freezeOAuthIdentityPlan({
    kind: 'new',
    provider,
    subject: identity.sub,
    generation: 0,
    user: {
      id: userId,
      email,
      name: resolveCurrentStoreOAuthDisplayName(identity, forwardedName),
      image: policy.storeProviderImage ? (identity.image ?? null) : null,
      emailVerified: emailVerified?.toISOString() ?? null,
      createdAt: createdAt.toISOString(),
    },
  });
  if (mode.kind === 'plan') return { outcome: 'planned', plan: planned };
  if (mode.kind === 'apply') requireSameOAuthIdentityPlan(mode.plan, planned);
  const created = await storage.createUser({
    id: userId,
    createdAt,
    email,
    name: planned.user.name,
    emailVerified,
    ...(policy.storeProviderImage ? { image: identity.image ?? null } : {}),
  });
  await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
  await transaction.insert(userProfiles).values({ userId }).onConflictDoNothing();
  // A legacy writer can race the absent row. A unique failure aborts ALL writes;
  // never ignore it and mint a credential for an unconfirmed provider owner.
  await storage.insertProvider({ userId, provider, subject: identity.sub }, 0);
  const inserted = await storage.findProvider(provider, identity.sub);
  if (!inserted || inserted.userId !== userId || inserted.generation !== 0)
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  await mirror(userId);
  return { outcome: 'created', user: created };
}

/** Existing callers keep one immediate identity write in their own transaction. */
export async function resolveReservedCurrentStoreOAuthIdentity(
  transaction: CurrentStoreTransaction,
  authority: ExpectedCurrentStoreAuthority,
  provider: CurrentStoreOAuthProvider,
  identity: VerifiedCurrentStoreOAuthIdentity,
  policy: CurrentStoreOAuthCreationPolicy,
  forwardedName?: CurrentStoreOAuthForwardedName,
  receipt?: IdentityAuthorityReceipt,
): Promise<ReservedCurrentStoreOAuthIdentity> {
  const result = await resolveReservedCurrentStoreOAuthIdentityInTransaction(
    transaction,
    authority,
    provider,
    identity,
    policy,
    forwardedName,
    receipt,
    { kind: 'write' },
  );
  if (result.outcome === 'planned') throw new CurrentStoreFoundationError('INVALID_COMMAND');
  return result;
}

/** Read-only planning under the same provider/user/email locks as the writer.
 * The backend fixes a new UID and public metadata before a credential is issued.
 * No mirror, reservation, profile, provider or user is written by this method. */
export async function planReservedCurrentStoreOAuthIdentity(
  transaction: CurrentStoreTransaction,
  authority: ExpectedCurrentStoreAuthority,
  provider: CurrentStoreOAuthProvider,
  identity: VerifiedCurrentStoreOAuthIdentity,
  policy: CurrentStoreOAuthCreationPolicy,
  forwardedName?: CurrentStoreOAuthForwardedName,
  receipt?: IdentityAuthorityReceipt,
): Promise<PlannedCurrentStoreOAuthIdentity> {
  const result = await resolveReservedCurrentStoreOAuthIdentityInTransaction(
    transaction,
    authority,
    provider,
    identity,
    policy,
    forwardedName,
    receipt,
    { kind: 'plan' },
  );
  if (result.outcome === 'linked' || result.outcome === 'created')
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  return result;
}

/** Internal transaction seam only. A provider command must durably bind the
 * entire backend-issued plan and verified input before accepting a preparation.
 * Rechecks actual subject ownership, generation and normalized-email conflicts;
 * the caller commits identity, credential and browser selection together. */
export async function applyReservedCurrentStoreOAuthIdentityPlan(
  transaction: CurrentStoreTransaction,
  authority: ExpectedCurrentStoreAuthority,
  provider: CurrentStoreOAuthProvider,
  identity: VerifiedCurrentStoreOAuthIdentity,
  policy: CurrentStoreOAuthCreationPolicy,
  plan: CurrentStoreOAuthIdentityPlan,
  forwardedName?: CurrentStoreOAuthForwardedName,
  receipt?: IdentityAuthorityReceipt,
): Promise<ReservedCurrentStoreOAuthIdentity> {
  const result = await resolveReservedCurrentStoreOAuthIdentityInTransaction(
    transaction,
    authority,
    provider,
    identity,
    policy,
    forwardedName,
    receipt,
    { kind: 'apply', plan },
  );
  if (result.outcome === 'planned') throw new CurrentStoreFoundationError('INVALID_COMMAND');
  return result;
}
