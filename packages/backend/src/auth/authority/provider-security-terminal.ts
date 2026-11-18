import { eq } from 'drizzle-orm';
import { authProviderReauthenticationReceipts, authProviderSecurityIntents } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase } from './adapter';
import {
  admitProviderActorInTransaction,
  captureProviderBoundCommand,
  loadProviderIntentInTransaction,
  providerDatabaseNow,
  providerTokenHash,
  providerWebSessionHash,
  ProviderSecurityRefusal,
} from './provider-security-context';
import {
  captureProviderSecurityRuntime,
  withProviderSecurityAuthority,
  type ProviderSecurityRuntime,
} from './provider-security-intents';

interface BoundInput {
  readonly actor: ProviderSecurityActor;
  readonly intentToken: string;
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
 * Lost backend ACK only: answers whether this exact intent committed, for the
 * session that made it. The session kept its token, so nothing is returned but
 * the generation it now has. Old intent, recovery and proof tokens alone never
 * acknowledge anything: the same live session must present them.
 */
export async function acknowledgeProviderSecurityResult(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: BoundInput & { readonly recoveryToken: string; readonly reauthenticationToken: string },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { recoveryToken, reauthenticationToken } = input;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    // This is only a preliminary lookup. User admission precedes the intent row
    // lock, matching the ordinary mutation's lock order.
    const [observed] = await transaction
      .select()
      .from(authProviderSecurityIntents)
      .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(command.intentToken)));
    if (
      !observed ||
      observed.phase !== 'committed' ||
      observed.actorCredentialHash !== command.actor.credentialHash ||
      observed.actorCredentialKind !== command.actor.input.presented.kind ||
      observed.userId !== command.actor.input.expectedUserId ||
      observed.actorSessionId !== command.actor.input.expectedAuthSessionId ||
      observed.browserBindingHash !== providerWebSessionHash(observed.actorSessionId) ||
      observed.recoveryTokenHash !== providerTokenHash(recoveryToken) ||
      observed.reauthenticationReceiptHash !== providerTokenHash(reauthenticationToken) ||
      observed.candidateCredentialHash !== observed.actorCredentialHash
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    if (
      observed.projectionId !== authority.projectionId ||
      observed.normalizerVersion !== authority.normalizerVersion ||
      observed.writerAuthority !== authority.authority ||
      observed.writerEpoch !== authority.epoch
    )
      throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
    const { session } = await admitProviderActorInTransaction(transaction, authority, command.actor);
    if (
      session.userId !== observed.userId ||
      session.authSessionId !== observed.actorSessionId ||
      session.generation !== observed.actorGeneration + 1 ||
      session.authenticatedAt?.getTime() !== observed.actorAuthenticatedAt?.getTime() ||
      session.linkGuarded !== observed.actorLinkGuarded ||
      session.requiresAccountCutoff !== observed.actorRequiresAccountCutoff
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
      intent.candidateCredentialHash !== observed.actorCredentialHash ||
      !intent.recoveryExpiresAt ||
      intent.recoveryExpiresAt.getTime() <= now.getTime() ||
      intent.expiresAt.getTime() <= now.getTime() ||
      !proof ||
      proof.intentHash !== intent.intentHash ||
      proof.consumedAt === null
    )
      throw new ProviderSecurityRefusal('denied', 'expired');
    return { outcome: 'recovered' as const, generation: session.generation };
  });
}
