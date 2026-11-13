import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { authEmailReservationMembers, authEmailReservations, users } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import { normalizeAccountEmail } from '../normalize-email';
import { transactionSettings } from '../current-store/command-context';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import { captureIdentityAuthority, revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';
import { bindIdentityAuthority } from './identity-authority';
import {
  admitProviderActorInTransaction,
  captureProviderActor,
  type CapturedProviderActor,
} from './provider-security-context';
import {
  captureFirstPasswordRuntime,
  firstPasswordEmailBinding,
  isAppleOnlyFirstPasswordInventory,
  type FirstPasswordRuntime,
} from './first-password-policy';

export class FirstPasswordRefusal extends Error {
  constructor(
    readonly outcome: 'denied' | 'identity_changed' | 'unavailable',
    readonly code: 'not_eligible' | 'already_set' | 'email_changed' | 'invalid_proof' | 'expired' | 'replayed',
  ) {
    super('First-password confirmation refused');
    this.name = 'FirstPasswordRefusal';
  }
}

export function captureFirstPasswordActor(input: ProviderSecurityActor, runtime: FirstPasswordRuntime) {
  // The private protocol independently checks the complete shape before pool
  // acquisition. Capture all primitives here before any authority await.
  return captureProviderActor(Object.freeze({ ...input }), runtime.legacySecret);
}

export async function withFirstPasswordAuthority<Result>(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  operation: (transaction: AuthorityTransaction, authority: IdentityAuthorityReceipt) => Promise<Result>,
): Promise<Result> {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  return database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const authority = await captureIdentityAuthority(transaction, runtime.qualification);
    const result = await operation(transaction, authority);
    await revalidateIdentityAuthority(transaction, authority);
    return result;
  });
}

/**
 * Actual source possession locks user/cutoff/binding first. Only that fixed UID
 * may own the current email reservation; an address never chooses an account.
 */
export async function lockFirstPasswordEligibility(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  runtime: FirstPasswordRuntime,
  actor: CapturedProviderActor,
) {
  const capturedRuntime = captureFirstPasswordRuntime(runtime);
  const admitted = await admitProviderActorInTransaction(transaction, authority, actor);
  const [user] = await transaction.select().from(users).where(eq(users.id, admitted.session.userId)).for('update');
  if (!user) throw new FirstPasswordRefusal('identity_changed', 'invalid_proof');
  const recipient = user.email.trim();
  if (!z.email().safeParse(recipient).success) throw new FirstPasswordRefusal('denied', 'not_eligible');
  const normalizedEmail = normalizeAccountEmail(recipient);
  const [reservation] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, normalizedEmail))
    .for('update');
  const members = await transaction
    .select({ userId: authEmailReservationMembers.userId })
    .from(authEmailReservationMembers)
    .where(eq(authEmailReservationMembers.normalizedEmail, normalizedEmail))
    .limit(2)
    .for('update');
  if (
    !reservation ||
    reservation.state !== 'owned' ||
    reservation.basisProjectionId !== authority.projectionId ||
    reservation.ownerUserId !== user.id ||
    members.length !== 1 ||
    members[0].userId !== user.id
  )
    throw new FirstPasswordRefusal('denied', 'not_eligible');
  const identity = bindIdentityAuthority(transaction, authority);
  if (await identity.readPassword(user.id, 'update')) throw new FirstPasswordRefusal('denied', 'already_set');
  const providers = await identity.listProviders(user.id, 'update');
  if (!isAppleOnlyFirstPasswordInventory(providers, user.id, admitted.session.generation))
    throw new FirstPasswordRefusal('denied', 'not_eligible');
  // A fresh read after provider row waits prevents observing an earlier email
  // value if an unfenced writer was already holding the user's row.
  const [current] = await transaction
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, user.id), eq(users.email, user.email)));
  if (!current) throw new FirstPasswordRefusal('identity_changed', 'email_changed');
  await revalidateIdentityAuthority(transaction, authority);
  return {
    ...admitted,
    identity,
    user,
    recipient,
    emailBindingHash: firstPasswordEmailBinding(capturedRuntime, authority, user.id, recipient),
  };
}
