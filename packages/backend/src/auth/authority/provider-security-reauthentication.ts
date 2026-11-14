import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authProviderReauthenticationReceipts } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import { bindIdentityAuthority, type IdentityPasswordSnapshot } from './identity-authority';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityQualification,
  type IdentityAuthorityReceipt,
} from './router';
import { transactionSettings } from '../current-store/command-context';
import { lockProviderSubject } from '../current-store/foundation-context';
import {
  captureProviderBoundCommand,
  loadProviderIntentInTransaction,
  providerDatabaseNow,
  providerReauthenticationBinding,
  providerTokenHash,
  ProviderSecurityRefusal,
  type ProviderSecurityIntent,
} from './provider-security-context';
import {
  requireProviderReauthenticationEvidence,
  verifyProviderGoogleReauthentication,
  verifyProviderPasswordReauthentication,
  type ProviderReauthenticationEvidence,
} from './provider-reauthentication-evidence';
import { isUsableProviderPassword, type ProviderSecurityMethodsConfiguration } from './provider-security-policy';

interface BoundInput {
  readonly actor: ProviderSecurityActor;
  readonly intentToken: string;
  readonly browserIntentToken: string;
}
export interface ProviderReauthenticationRuntime {
  readonly qualification: IdentityAuthorityQualification;
  readonly legacySecret: string | undefined;
  readonly methods: ProviderSecurityMethodsConfiguration;
}
function captureRuntime(runtime: ProviderReauthenticationRuntime): ProviderReauthenticationRuntime {
  return Object.freeze({
    qualification: Object.freeze({ ...runtime.qualification }),
    legacySecret: runtime.legacySecret,
    methods: Object.freeze({
      ...runtime.methods,
      configuredProviders: Object.freeze([...runtime.methods.configuredProviders]),
    }),
  });
}
async function withReceipt<T>(
  database: AuthorityDatabase,
  runtime: ProviderReauthenticationRuntime,
  operation: (transaction: AuthorityTransaction, authority: IdentityAuthorityReceipt) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const authority = await captureIdentityAuthority(transaction, runtime.qualification);
    const result = await operation(transaction, authority);
    await revalidateIdentityAuthority(transaction, authority);
    return result;
  });
}
function samePassword(left: IdentityPasswordSnapshot | null, right: IdentityPasswordSnapshot | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.userId === right.userId &&
    left.generation === right.generation &&
    left.passwordHash === right.passwordHash
  );
}
async function persistVerifiedReceipt(
  transaction: AuthorityTransaction,
  intent: ProviderSecurityIntent,
  evidence: ProviderReauthenticationEvidence,
) {
  const now = await providerDatabaseNow(transaction);
  const verified = requireProviderReauthenticationEvidence(evidence, providerReauthenticationBinding(intent), now);
  const token = randomBytes(32).toString('base64url');
  // Replacing a still-pending receipt does not extend its underlying proof age.
  await transaction
    .update(authProviderReauthenticationReceipts)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authProviderReauthenticationReceipts.intentHash, intent.intentHash),
        isNull(authProviderReauthenticationReceipts.consumedAt),
      ),
    );
  await transaction.insert(authProviderReauthenticationReceipts).values({
    receiptHash: providerTokenHash(token),
    intentHash: intent.intentHash,
    method: verified.method,
    proofBindingHash: verified.proofBindingHash,
    proofProviderSubject: verified.providerSubject,
    authenticatedAt: verified.authenticatedAt,
    proofExpiresAt: verified.proofExpiresAt,
    issuedAt: now,
    expiresAt: verified.expiresAt,
  });
  const finishedAt = await providerDatabaseNow(transaction);
  requireProviderReauthenticationEvidence(evidence, providerReauthenticationBinding(intent), finishedAt);
  return { reauthenticationToken: token, expiresAt: new Date(verified.expiresAt) };
}

/** Real bcrypt runs outside transactions, then the exact primary hash is locked and re-read. */
export async function reauthenticateProviderWithPassword(
  database: AuthorityDatabase,
  runtimeInput: ProviderReauthenticationRuntime,
  input: BoundInput & { readonly password: string },
) {
  const runtime = captureRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const submittedPassword = input.password;
  const before = await withReceipt(database, runtime, async (transaction, authority) => {
    const bound = await loadProviderIntentInTransaction(transaction, authority, command, ['pending']);
    const password = await bindIdentityAuthority(transaction, authority).readPassword(bound.session.userId);
    if (!isUsableProviderPassword(password, bound.session.userId, bound.session.generation))
      throw new ProviderSecurityRefusal('reauthentication_unavailable', 'invalid_proof');
    return { authority, intent: bound.intent, password: password!, now: bound.now };
  });
  const evidence = await verifyProviderPasswordReauthentication({
    binding: providerReauthenticationBinding(before.intent),
    password: before.password,
    databaseStartedAt: before.now,
    submittedPassword,
  });
  if (!evidence) throw new ProviderSecurityRefusal('reauthentication_required', 'invalid_proof');
  return withReceipt(database, runtime, async (transaction, authority) => {
    await revalidateIdentityAuthority(transaction, before.authority);
    const bound = await loadProviderIntentInTransaction(transaction, authority, command, ['pending']);
    const password = await bindIdentityAuthority(transaction, authority).readPassword(bound.session.userId, 'update');
    if (!samePassword(password, before.password))
      throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
    return persistVerifiedReceipt(transaction, bound.intent, evidence);
  });
}

/** Signed Google auth_time authorizes only an already-owned subject and this exact nonce-bound intent. */
export async function reauthenticateProviderWithGoogle(
  database: AuthorityDatabase,
  runtimeInput: ProviderReauthenticationRuntime,
  input: BoundInput & { readonly flowHash: string; readonly nonce: string; readonly idToken: string },
) {
  const runtime = captureRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { flowHash, nonce, idToken } = input;
  if (!runtime.methods.googleReauthenticationEnabled)
    throw new ProviderSecurityRefusal('reauthentication_unavailable', 'provider_unavailable');
  const before = await withReceipt(database, runtime, async (transaction, authority) => {
    const bound = await loadProviderIntentInTransaction(transaction, authority, command, ['pending']);
    if (
      bound.intent.reauthenticationFlowHash !== flowHash ||
      bound.intent.reauthenticationNonceHash !== providerTokenHash(nonce)
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    return { authority, intent: bound.intent, now: bound.now };
  });
  const evidence = await verifyProviderGoogleReauthentication({
    binding: providerReauthenticationBinding(before.intent),
    configuration: runtime.methods,
    databaseStartedAt: before.now,
    nonce,
    idToken,
  });
  if (!evidence) throw new ProviderSecurityRefusal('reauthentication_required', 'invalid_proof');
  // Extract only verified, unforgeable evidence before selecting the subject lock.
  const verified = requireProviderReauthenticationEvidence(
    evidence,
    providerReauthenticationBinding(before.intent),
    before.now,
  );
  if (!verified.providerSubject) throw new ProviderSecurityRefusal('denied', 'invalid_proof');
  const subject = verified.providerSubject;
  return withReceipt(database, runtime, async (transaction, authority) => {
    await revalidateIdentityAuthority(transaction, before.authority);
    await lockProviderSubject(transaction, 'google', subject);
    const identity = bindIdentityAuthority(transaction, authority);
    const observed = await identity.findProvider('google', subject);
    const bound = await loadProviderIntentInTransaction(transaction, authority, command, ['pending']);
    if (
      bound.intent.reauthenticationFlowHash !== flowHash ||
      bound.intent.reauthenticationNonceHash !== providerTokenHash(nonce)
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    const owner = await identity.findProvider('google', subject, 'update');
    if (
      !observed ||
      !owner ||
      observed.userId !== owner.userId ||
      observed.generation !== owner.generation ||
      owner.userId !== bound.session.userId ||
      owner.generation !== bound.session.generation
    )
      throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
    return persistVerifiedReceipt(transaction, bound.intent, evidence);
  });
}
