import { randomBytes, randomUUID } from 'node:crypto';
import { and, count, eq, gt, inArray } from 'drizzle-orm';
import { authProviderSecurityIntents } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor, ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import { bindIdentityAuthority } from './identity-authority';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityQualification,
  type IdentityAuthorityReceipt,
} from './router';
import { transactionSettings } from '../current-store/command-context';
import {
  admitProviderActorInTransaction,
  captureProviderActor,
  captureProviderBoundCommand,
  loadProviderIntentInTransaction,
  providerDatabaseNow,
  providerTokenHash,
  providerWebSessionHash,
  providerWebSessionIntentHash,
  PROVIDER_WEB_SESSION_BROWSER_VERSION,
  ProviderSecurityRefusal,
  requireCanonicalProviderActor,
} from './provider-security-context';
import {
  isUsableProviderIdentity,
  isUsableProviderPassword,
  providerMethodId,
  PROVIDER_SECURITY_INTENT_LIFETIME_MS,
  PROVIDER_SECURITY_LIVE_INTENTS_PER_SESSION,
  type ProviderSecurityMethodsConfiguration,
} from './provider-security-policy';

export interface ProviderSecurityRuntime {
  readonly qualification: IdentityAuthorityQualification;
  readonly legacySecret: string | undefined;
  readonly methods: ProviderSecurityMethodsConfiguration;
}
export function captureProviderSecurityRuntime(input: ProviderSecurityRuntime): ProviderSecurityRuntime {
  return Object.freeze({
    qualification: Object.freeze({ ...input.qualification }),
    legacySecret: input.legacySecret,
    methods: Object.freeze({
      ...input.methods,
      configuredProviders: Object.freeze([...input.methods.configuredProviders]),
    }),
  });
}
export async function withProviderSecurityAuthority<T>(
  database: AuthorityDatabase,
  runtime: ProviderSecurityRuntime,
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

/** Display inventory only. The mutation re-locks and re-reads every retained method. */
export async function readProviderSecurityMethods(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: ProviderSecurityActor,
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const actor = captureProviderActor(input, runtime.legacySecret);
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const { session } = await admitProviderActorInTransaction(transaction, authority, actor);
    const identity = bindIdentityAuthority(transaction, authority);
    const password = await identity.readPassword(session.userId);
    const providers = await identity.listProviders(session.userId);
    const passwordUsable = isUsableProviderPassword(password, session.userId, session.generation);
    const usable = providers.filter((provider) =>
      isUsableProviderIdentity(provider, session.userId, session.generation, runtime.methods),
    );
    return {
      passwordUsable,
      providers: providers
        .filter((provider) => provider.provider === 'google' || provider.provider === 'apple')
        .map((provider) => ({
          methodId: providerMethodId(provider),
          provider: provider.provider as ProviderSecurityProvider,
          usable: isUsableProviderIdentity(provider, session.userId, session.generation, runtime.methods),
          canUnlink:
            passwordUsable ||
            usable.some((retained) => retained.provider !== provider.provider || retained.subject !== provider.subject),
        })),
      configuredProviders: [...runtime.methods.configuredProviders],
      googleReauthenticationAvailable:
        runtime.methods.googleReauthenticationEnabled && usable.some((provider) => provider.provider === 'google'),
    };
  });
}

export async function createProviderSecurityIntent(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: {
    readonly actor: ProviderSecurityActor;
    readonly action: 'link' | 'unlink';
    readonly provider: ProviderSecurityProvider;
    readonly methodId: string | null;
  },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const actor = captureProviderActor(input.actor, runtime.legacySecret);
  const { action, provider, methodId } = input;
  const intentToken = randomBytes(32).toString('base64url');
  const recoveryToken = randomBytes(32).toString('base64url');
  const operationId = randomUUID();
  if (action === 'link' && !runtime.methods.configuredProviders.includes(provider))
    throw new ProviderSecurityRefusal('denied', 'provider_unavailable');
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const { session } = await admitProviderActorInTransaction(transaction, authority, actor);
    requireCanonicalProviderActor(actor);
    const now = await providerDatabaseNow(transaction);
    // One session may hold only a few live intents; the users lock taken by
    // admission serializes this count with every other intent of the account.
    const [live] = await transaction
      .select({ total: count() })
      .from(authProviderSecurityIntents)
      .where(
        and(
          eq(authProviderSecurityIntents.browserBindingHash, providerWebSessionHash(session.authSessionId)),
          inArray(authProviderSecurityIntents.phase, ['pending', 'prepared']),
          gt(authProviderSecurityIntents.expiresAt, now),
        ),
      );
    if ((live?.total ?? 0) >= PROVIDER_SECURITY_LIVE_INTENTS_PER_SESSION)
      throw new ProviderSecurityRefusal('denied', 'too_many_pending');
    let providerSubject: string | null = null;
    if (action === 'unlink') {
      const methods = await bindIdentityAuthority(transaction, authority).listProviders(session.userId);
      const selected = methods.filter(
        (candidate) =>
          candidate.provider === provider &&
          providerMethodId(candidate) === methodId &&
          candidate.generation === session.generation,
      );
      if (selected.length !== 1) throw new ProviderSecurityRefusal('denied', 'invalid_proof');
      providerSubject = selected[0].subject;
    } else if (methodId !== null) throw new ProviderSecurityRefusal('denied', 'invalid_intent');
    const expiresAt = new Date(
      Math.min(now.getTime() + PROVIDER_SECURITY_INTENT_LIFETIME_MS, session.expiresAt.getTime()),
    );
    if (expiresAt.getTime() <= now.getTime()) throw new ProviderSecurityRefusal('denied', 'expired');
    const intentHash = providerTokenHash(intentToken);
    await transaction.insert(authProviderSecurityIntents).values({
      intentHash,
      operationId,
      userId: session.userId,
      actorCredentialKind: actor.input.presented.kind,
      actorCredentialHash: actor.credentialHash,
      recoveryTokenHash: providerTokenHash(recoveryToken),
      // The NOT NULL binding columns, keyed by the web session (no migration).
      browserBindingHash: providerWebSessionHash(session.authSessionId),
      browserVersion: PROVIDER_WEB_SESSION_BROWSER_VERSION,
      browserIntentHash: providerWebSessionIntentHash(intentHash),
      browserBindingExpiresAt: session.expiresAt,
      actorSessionId: session.authSessionId,
      actorGeneration: session.generation,
      actorAuthenticatedAt: session.authenticatedAt,
      actorLinkGuarded: session.linkGuarded,
      actorRequiresAccountCutoff: session.requiresAccountCutoff,
      actorExpiresAt: session.expiresAt,
      operation: action,
      provider,
      providerSubject,
      projectionId: authority.projectionId,
      normalizerVersion: authority.normalizerVersion,
      writerAuthority: authority.authority,
      writerEpoch: authority.epoch,
      issuedAt: now,
      expiresAt,
    });
    return { intentToken, recoveryToken, expiresAt };
  });
}

/** State and nonce are captured from the real issuer's generated OAuth request. */
export async function bindProviderSecurityFlow(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: {
    readonly actor: ProviderSecurityActor;
    readonly intentToken: string;
    readonly flowHash: string;
    readonly nonceHash?: string;
  },
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = captureProviderBoundCommand(input, runtime.legacySecret);
  const { flowHash, nonceHash } = input;
  if (nonceHash !== undefined && !runtime.methods.googleReauthenticationEnabled)
    throw new ProviderSecurityRefusal('reauthentication_unavailable', 'provider_unavailable');
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const { intent } = await loadProviderIntentInTransaction(transaction, authority, command, ['pending']);
    if (!/^[a-f0-9]{64}$/.test(flowHash) || (nonceHash !== undefined && !/^[a-f0-9]{64}$/.test(nonceHash)))
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    if (nonceHash === undefined) {
      if (intent.operation !== 'link' || (intent.flowHash !== null && intent.flowHash !== flowHash))
        throw new ProviderSecurityRefusal('denied', 'invalid_intent');
      await transaction
        .update(authProviderSecurityIntents)
        .set({ flowHash })
        .where(eq(authProviderSecurityIntents.intentHash, intent.intentHash));
    } else {
      if (
        (intent.reauthenticationFlowHash !== null && intent.reauthenticationFlowHash !== flowHash) ||
        (intent.reauthenticationNonceHash !== null && intent.reauthenticationNonceHash !== nonceHash)
      )
        throw new ProviderSecurityRefusal('denied', 'invalid_intent');
      await transaction
        .update(authProviderSecurityIntents)
        .set({ reauthenticationFlowHash: flowHash, reauthenticationNonceHash: nonceHash })
        .where(eq(authProviderSecurityIntents.intentHash, intent.intentHash));
    }
    return { outcome: 'bound' as const };
  });
}
