import { eq } from 'drizzle-orm';
import { authProviderReauthenticationReceipts, authProviderSecurityIntents } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase } from './adapter';
import { readBrowserBindingInTransaction } from './browser-binding';
import {
  captureProviderBoundCommand,
  loadProviderIntentInTransaction,
  providerDatabaseNow,
  providerTokenHash,
  ProviderSecurityRefusal,
} from './provider-security-context';
import {
  captureProviderSecurityRuntime,
  withProviderSecurityAuthority,
  type ProviderSecurityRuntime,
} from './provider-security-intents';
import {
  providerCandidateCredentialSchema,
  providerCredentialHash,
  type ProviderCandidateCredential,
} from './provider-security-result';

interface BoundInput {
  readonly actor: ProviderSecurityActor;
  readonly intentToken: string;
  readonly browserIntentToken: string;
}

/** A validated cancellation/error consumes only its exact current intent. */
export async function abortProviderSecurityMutation(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: BoundInput & { readonly preparationToken: string | null; readonly flowHash: string | null },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { preparationToken, flowHash } = input;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const { intent, now } = await loadProviderIntentInTransaction(transaction, authority, command, [
      'pending',
      'prepared',
    ]);
    if (
      (preparationToken !== null && intent.preparationTokenHash !== providerTokenHash(preparationToken)) ||
      (flowHash !== null && intent.flowHash !== flowHash && intent.reauthenticationFlowHash !== flowHash)
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_intent');
    await transaction
      .update(authProviderSecurityIntents)
      .set({ phase: 'terminal', consumedAt: now, candidateCredentialHash: null, recoveryExpiresAt: null })
      .where(eq(authProviderSecurityIntents.intentHash, intent.intentHash));
    return { outcome: 'aborted' as const };
  });
}

/**
 * Lost backend ACK only: the caller must already possess the exact candidate.
 * Old actor/intent/proof tokens never retrieve or reconstruct any bearer. A
 * lost complete browser response needs a separately qualified fresh sign-in.
 */
export async function acknowledgeProviderSecurityResult(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: BoundInput & {
    readonly recoveryToken: string;
    readonly reauthenticationToken: string;
    readonly candidate: ProviderCandidateCredential;
  },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { recoveryToken, reauthenticationToken } = input;
  const candidate = providerCandidateCredentialSchema.parse({ ...input.candidate });
  const candidateHash = providerCredentialHash(candidate);
  if (candidate.kind === 'legacy-jwe' && !runtime.legacySecret)
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  const credential =
    candidate.kind === 'canonical-token'
      ? { kind: candidate.kind, token: candidate.credential }
      : { kind: candidate.kind, credential: candidate.credential, secret: runtime.legacySecret! };
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    // This is only a preliminary lookup. User/binding admission precedes the
    // intent row lock, matching the ordinary mutation and browser lock order.
    const [observed] = await transaction
      .select()
      .from(authProviderSecurityIntents)
      .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(command.intentToken)));
    if (
      !observed ||
      observed.phase !== 'committed' ||
      observed.actorCredentialHash !== command.actor.credentialHash ||
      observed.actorCredentialKind !== command.actor.input.kind ||
      candidate.kind !== observed.actorCredentialKind ||
      observed.userId !== command.actor.input.expectedUserId ||
      observed.actorSessionId !== command.actor.input.expectedAuthSessionId ||
      observed.browserBindingHash !== providerTokenHash(command.actor.input.browserBindingToken) ||
      observed.browserVersion !== command.actor.input.browserVersion ||
      observed.browserIntentHash !== providerTokenHash(command.browserIntentToken) ||
      observed.recoveryTokenHash !== providerTokenHash(recoveryToken) ||
      observed.reauthenticationReceiptHash !== providerTokenHash(reauthenticationToken) ||
      observed.candidateCredentialHash !== candidateHash
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    if (
      observed.projectionId !== authority.projectionId ||
      observed.normalizerVersion !== authority.normalizerVersion ||
      observed.writerAuthority !== authority.authority ||
      observed.writerEpoch !== authority.epoch
    )
      throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
    const admitted = await readBrowserBindingInTransaction(transaction, authority, {
      bindingToken: command.actor.input.browserBindingToken,
      actor: { version: observed.browserVersion + 1, credential },
    });
    if (admitted.status === 'unavailable') throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
    if (
      admitted.status !== 'admitted' ||
      admitted.cursor.version !== observed.browserVersion + 1 ||
      admitted.session.userId !== observed.userId ||
      admitted.session.authSessionId !== observed.actorSessionId ||
      admitted.session.generation !== observed.actorGeneration + 1 ||
      admitted.session.authenticatedAt?.getTime() !== observed.actorAuthenticatedAt?.getTime() ||
      admitted.session.linkGuarded !== observed.actorLinkGuarded ||
      admitted.session.requiresAccountCutoff !== observed.actorRequiresAccountCutoff ||
      admitted.session.expiresAt.getTime() !== observed.actorExpiresAt.getTime()
    )
      throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
    const [intent] = await transaction
      .select()
      .from(authProviderSecurityIntents)
      .where(eq(authProviderSecurityIntents.intentHash, observed.intentHash))
      .for('update');
    const [proof] = await transaction
      .select()
      .from(authProviderReauthenticationReceipts)
      .where(eq(authProviderReauthenticationReceipts.receiptHash, observed.reauthenticationReceiptHash!));
    const now = await providerDatabaseNow(transaction);
    if (
      !intent ||
      intent.phase !== 'committed' ||
      intent.candidateCredentialHash !== candidateHash ||
      !intent.recoveryExpiresAt ||
      intent.recoveryExpiresAt.getTime() <= now.getTime() ||
      intent.expiresAt.getTime() <= now.getTime() ||
      !proof ||
      proof.intentHash !== intent.intentHash ||
      proof.consumedAt === null
    )
      throw new ProviderSecurityRefusal('denied', 'expired');
    return { outcome: 'recovered' as const, candidateCredentialHash: candidateHash, browserCursor: admitted.cursor };
  });
}
