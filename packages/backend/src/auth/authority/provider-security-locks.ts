import { and, eq } from 'drizzle-orm';
import { authProviderReauthenticationReceipts, authProviderSecurityIntents } from '@boardsesh/db/schema/auth';
import type { AuthorityTransaction } from './adapter';
import { bindIdentityAuthority, type ProviderIdentitySnapshot } from './identity-authority';
import { lockProviderSubject } from '../current-store/foundation-context';
import type { IdentityAuthorityReceipt } from './router';
import {
  loadProviderIntentInTransaction,
  providerDatabaseNow,
  providerTokenHash,
  ProviderSecurityRefusal,
  type ProviderBoundCommand,
  type ProviderSecurityIntent,
} from './provider-security-context';
import { isUsableProviderPassword } from './provider-security-policy';
import { providerPasswordProofBindingHash } from './provider-reauthentication-evidence';

type ReauthenticationReceipt = typeof authProviderReauthenticationReceipts.$inferSelect;
const providerKey = (provider: string, subject: string) => JSON.stringify([provider, subject]);
function sameOwner(left: ProviderIdentitySnapshot | null, right: ProviderIdentitySnapshot | null): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.provider === right.provider &&
        left.subject === right.subject &&
        left.userId === right.userId &&
        left.generation === right.generation;
}
function supportedInventory(rows: readonly ProviderIdentitySnapshot[]): string {
  return JSON.stringify(
    rows
      .filter((row) => row.provider === 'google' || row.provider === 'apple')
      .map((row) => JSON.stringify([row.provider, row.subject, row.userId, row.generation]))
      .sort(),
  );
}
function requireReceiptDeadline(receipt: ReauthenticationReceipt, intent: ProviderSecurityIntent, now: Date) {
  const times = [receipt.authenticatedAt, receipt.issuedAt, receipt.expiresAt, receipt.proofExpiresAt, now].map(
    (clock) => clock.getTime(),
  );
  if (
    times.some((clock) => !Number.isSafeInteger(clock) || clock <= 0) ||
    receipt.consumedAt !== null ||
    receipt.authenticatedAt.getTime() > receipt.issuedAt.getTime() ||
    receipt.issuedAt.getTime() > now.getTime() ||
    receipt.expiresAt.getTime() <= now.getTime() ||
    receipt.expiresAt.getTime() > intent.expiresAt.getTime() ||
    receipt.expiresAt.getTime() > receipt.authenticatedAt.getTime() + 300_000 ||
    receipt.expiresAt.getTime() > receipt.proofExpiresAt.getTime()
  )
    throw new ProviderSecurityRefusal('reauthentication_required', 'expired');
}

/**
 * Gate -> sorted provider subjects -> user/cutoff/browser -> primary provider
 * rows -> selected credential/proof. A fresh statement after each row lock sees
 * a previously uncommitted unfenced owner/hash change; MVCC snapshots cannot
 * authorize reassignment or an obsolete password proof.
 */
export async function lockProviderSecurityMutationContext(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  command: ProviderBoundCommand,
  reauthenticationToken: string,
  phases: readonly ProviderSecurityIntent['phase'][],
  linkingSubject?: string,
) {
  const [snapshot] = await transaction
    .select()
    .from(authProviderSecurityIntents)
    .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(command.intentToken)));
  if (
    !snapshot ||
    snapshot.actorCredentialHash !== command.actor.credentialHash ||
    snapshot.userId !== command.actor.input.expectedUserId ||
    snapshot.actorSessionId !== command.actor.input.expectedAuthSessionId
  )
    throw new ProviderSecurityRefusal('identity_changed', 'invalid_intent');
  const targetSubject = linkingSubject ?? snapshot.providerSubject;
  if (
    !targetSubject ||
    targetSubject.length > 1024 ||
    (snapshot.providerSubject !== null && snapshot.providerSubject !== targetSubject)
  )
    throw new ProviderSecurityRefusal('denied', 'invalid_proof');
  const receiptHash = providerTokenHash(reauthenticationToken);
  const [proofSnapshot] = await transaction
    .select()
    .from(authProviderReauthenticationReceipts)
    .where(
      and(
        eq(authProviderReauthenticationReceipts.receiptHash, receiptHash),
        eq(authProviderReauthenticationReceipts.intentHash, snapshot.intentHash),
      ),
    );
  if (
    !proofSnapshot ||
    (snapshot.reauthenticationReceiptHash !== null && snapshot.reauthenticationReceiptHash !== receiptHash)
  )
    throw new ProviderSecurityRefusal('reauthentication_required', 'invalid_proof');
  const identity = bindIdentityAuthority(transaction, authority);
  const listed = await identity.listProviders(snapshot.userId);
  const subjects = new Map<string, { provider: string; subject: string }>();
  for (const row of listed)
    if (row.provider === 'google' || row.provider === 'apple')
      subjects.set(providerKey(row.provider, row.subject), row);
  subjects.set(providerKey(snapshot.provider, targetSubject), { provider: snapshot.provider, subject: targetSubject });
  if (proofSnapshot.method === 'google-auth-time' && proofSnapshot.proofProviderSubject)
    subjects.set(providerKey('google', proofSnapshot.proofProviderSubject), {
      provider: 'google',
      subject: proofSnapshot.proofProviderSubject,
    });
  const orderedSubjects = [...subjects].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const observed = new Map<string, ProviderIdentitySnapshot | null>();
  for (const [key, subject] of orderedSubjects) {
    await lockProviderSubject(transaction, subject.provider, subject.subject);
    observed.set(key, await identity.findProvider(subject.provider, subject.subject));
  }
  const bound = await loadProviderIntentInTransaction(transaction, authority, command, phases);
  if (
    bound.intent.provider !== snapshot.provider ||
    bound.intent.operation !== snapshot.operation ||
    bound.intent.providerSubject !== snapshot.providerSubject ||
    supportedInventory(await identity.listProviders(bound.session.userId)) !== supportedInventory(listed)
  )
    throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  const locked = new Map<string, ProviderIdentitySnapshot | null>();
  for (const [key, subject] of orderedSubjects) {
    const owner = await identity.findProvider(subject.provider, subject.subject, 'update');
    if (!sameOwner(observed.get(key) ?? null, owner))
      throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
    locked.set(key, owner);
  }
  const [proof] = await transaction
    .select()
    .from(authProviderReauthenticationReceipts)
    .where(
      and(
        eq(authProviderReauthenticationReceipts.receiptHash, receiptHash),
        eq(authProviderReauthenticationReceipts.intentHash, bound.intent.intentHash),
      ),
    )
    .for('update');
  if (!proof) throw new ProviderSecurityRefusal('reauthentication_required', 'invalid_proof');
  const password = await identity.readPassword(bound.session.userId, 'update');
  if (proof.method === 'password') {
    if (
      !isUsableProviderPassword(password, bound.session.userId, bound.session.generation) ||
      providerPasswordProofBindingHash(password!) !== proof.proofBindingHash
    )
      throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  } else if (proof.method === 'google-auth-time' && proof.proofProviderSubject) {
    const owner = locked.get(providerKey('google', proof.proofProviderSubject));
    if (!owner || owner.userId !== bound.session.userId || owner.generation !== bound.session.generation)
      throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  } else throw new ProviderSecurityRefusal('reauthentication_required', 'invalid_proof');
  const now = await providerDatabaseNow(transaction);
  requireReceiptDeadline(proof, bound.intent, now);
  return {
    ...bound,
    now,
    identity,
    proof,
    password,
    providers: [...locked.values()].filter((owner): owner is ProviderIdentitySnapshot => owner !== null),
    target: locked.get(providerKey(bound.intent.provider, targetSubject)) ?? null,
    targetSubject,
  };
}
