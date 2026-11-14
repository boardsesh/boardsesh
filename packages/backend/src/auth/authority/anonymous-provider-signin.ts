import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authBrowserBindings, authBrowserIntents, authSession, authWebOAuthIntents } from '@boardsesh/db/schema/auth';
import {
  anonymousProviderCommandSchema,
  anonymousProviderPayloadSchemas,
  anonymousProviderPreparationSchema,
  anonymousProviderReplySchema,
  providerIdentityPlanSchema,
  type AnonymousProviderCommand,
  type AnonymousProviderOperation,
  type AnonymousProviderPreparation,
  type AnonymousProviderReply,
  type ProviderIdentityPlan,
} from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  acknowledgeAnonymousBrowserLoginInTransaction,
  beginAnonymousBrowserIntent,
  commitBrowserLoginInTransaction,
  readAnonymousBrowserBindingInTransaction,
  type BrowserBindingCursor,
} from './browser-binding';
import {
  applyReservedCurrentStoreOAuthIdentityPlan,
  planReservedCurrentStoreOAuthIdentity,
} from '../current-store/provider-oauth-identity';
import { isWebPasswordCommandFresh } from '../current-store/command-context';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import { readIdentityAuthority, revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';
import {
  captureProviderSecurityRuntime,
  withProviderSecurityAuthority,
  type ProviderSecurityRuntime,
} from './provider-security-intents';
import { providerDatabaseNow, providerTokenHash, ProviderSecurityRefusal } from './provider-security-context';
import { providerCredentialHash } from './provider-security-result';
import { googleReauthenticationDeadline } from './provider-security-policy';
import { verifyProviderGoogleAuthenticationAssertion } from './provider-google-reauthentication';

type Payload<Operation extends AnonymousProviderOperation> = Extract<
  AnonymousProviderCommand,
  { operation: Operation }
>['payload'];
type Bound = Omit<Payload<'prepare'>, 'credentialKind' | 'providerProof'>;
type FlowRow = typeof authWebOAuthIntents.$inferSelect;
type Code =
  | 'invalid_intent'
  | 'invalid_proof'
  | 'expired'
  | 'replayed'
  | 'provider_unavailable'
  | 'ownership_conflict'
  | 'authority_unavailable';
const policy = Object.freeze({ actorUserId: null, storeProviderImage: true, emailVerification: 'unverified' } as const);
const hash = (parts: readonly unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const flowId = (token: string) => hash(['anonymous-provider-flow-v1', token]);
const preparationId = (token: string) => hash(['anonymous-provider-preparation-v1', token]);
function refuse(code: Code, outcome: 'denied' | 'identity_changed' | 'unavailable' = 'denied'): never {
  throw new ProviderSecurityRefusal(outcome, code);
}
function capture<Operation extends AnonymousProviderOperation>(
  operation: Operation,
  payload: Payload<Operation>,
): Payload<Operation> {
  return anonymousProviderPayloadSchemas[operation].parse(payload) as Payload<Operation>;
}
function expectedAuthority(authority: IdentityAuthorityReceipt) {
  return {
    expectedProjectionId: authority.projectionId,
    expectedNormalizerVersion: authority.normalizerVersion,
    expectedWriterEpoch: authority.epoch,
  };
}
function flowBinding(
  input: Bound,
  provider: string,
  kind: string,
  authority: IdentityAuthorityReceipt,
  cursor: BrowserBindingCursor,
): string {
  return hash([
    'anonymous-provider-flow-binding-v1',
    provider,
    kind,
    input.flowHash,
    input.nonceHash,
    providerTokenHash(input.browser.bindingToken),
    input.browser.expectedVersion,
    cursor.bindingExpiresAt.toISOString(),
    providerTokenHash(input.browserIntentToken),
    authority.projectionId,
    authority.normalizerVersion,
    authority.authority,
    authority.epoch,
  ]);
}
function preparedBinding(
  input: Bound,
  preparation: AnonymousProviderPreparation,
  authority: IdentityAuthorityReceipt,
  cursor: BrowserBindingCursor,
): string {
  return hash([
    'anonymous-provider-prepared-binding-v1',
    flowId(input.intentToken),
    flowBinding(input, preparation.identityPlan.provider, preparation.credentialKind, authority, cursor),
    preparation,
  ]);
}
async function anonymous(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  input: Bound['browser'],
) {
  const result = await readAnonymousBrowserBindingInTransaction(transaction, authority, input);
  if (result.status !== 'anonymous')
    return refuse('invalid_proof', result.status === 'unavailable' ? 'unavailable' : 'identity_changed');
  return result.cursor;
}
async function browserIntent(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  input: Bound,
  cursor: BrowserBindingCursor,
  now: Date,
  allowCanceled = false,
) {
  const [observed] = await transaction
    .select({ intent: authBrowserIntents, revision: authBrowserBindings.intentRevision })
    .from(authBrowserIntents)
    .innerJoin(authBrowserBindings, eq(authBrowserIntents.bindingId, authBrowserBindings.id))
    .where(
      and(
        eq(authBrowserIntents.id, providerTokenHash(input.browserIntentToken)),
        eq(authBrowserBindings.id, cursor.bindingId),
      ),
    )
    .for('update', { of: authBrowserIntents });
  const canceled =
    allowCanceled &&
    observed?.intent.consumedAt !== null &&
    observed?.intent.resultVersion === input.browser.expectedVersion + 1 &&
    observed?.intent.resultCredentialHash === null;
  if (
    !observed ||
    observed.intent.formatVersion !== 2 ||
    observed.intent.operation !== 'login' ||
    observed.intent.actorCredentialHash !== null ||
    observed.intent.expectedVersion !== input.browser.expectedVersion ||
    observed.intent.revision !== observed.revision ||
    observed.intent.projectionId !== authority.projectionId ||
    observed.intent.authority !== authority.authority ||
    observed.intent.epoch !== authority.epoch ||
    observed.intent.expiresAt.getTime() <= now.getTime() ||
    (!canceled &&
      (observed.intent.consumedAt !== null ||
        observed.intent.resultVersion !== null ||
        observed.intent.resultCredentialHash !== null))
  )
    return refuse('invalid_intent');
  return observed.intent;
}
async function initialFlow(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  input: Bound,
  kind: string,
  cursor: BrowserBindingCursor,
) {
  const [flow] = await transaction
    .select()
    .from(authWebOAuthIntents)
    .where(eq(authWebOAuthIntents.intentHash, flowId(input.intentToken)))
    .for('update');
  if (
    !flow ||
    flow.actorUserId !== null ||
    flow.actorLineageHash !== null ||
    flow.actorObservedGeneration !== null ||
    flow.flowHash !== flowBinding(input, flow.provider, kind, authority, cursor)
  )
    return refuse('invalid_intent');
  if (flow.expiresAt.getTime() <= (await providerDatabaseNow(transaction)).getTime()) return refuse('expired');
  return flow;
}
async function consume(transaction: AuthorityTransaction, flow: FlowRow, now: Date) {
  const [consumed] = await transaction
    .update(authWebOAuthIntents)
    .set({ consumedAt: now })
    .where(and(eq(authWebOAuthIntents.intentHash, flow.intentHash), isNull(authWebOAuthIntents.consumedAt)))
    .returning();
  if (!consumed) return refuse('replayed');
}
function samePlan(expected: ProviderIdentityPlan, observed: ProviderIdentityPlan, permitCreatedOwner = false): boolean {
  const actual = providerIdentityPlanSchema.parse({
    ...observed,
    ...(permitCreatedOwner && expected.kind === 'new' ? { kind: 'new' } : {}),
  });
  return JSON.stringify(providerIdentityPlanSchema.parse(expected)) === JSON.stringify(actual);
}
function requirePreparation(preparation: AnonymousProviderPreparation): void {
  const plan = preparation.identityPlan;
  const proof = preparation.credentialProof;
  if (
    proof.userId !== plan.user.id ||
    proof.generation !== plan.generation ||
    proof.requiresAccountCutoff ||
    (plan.kind === 'new' && plan.generation !== 0) ||
    plan.subject !== preparation.verifiedIdentity.sub ||
    (preparation.proposedCanonicalTokenHash !== null) !== (preparation.credentialKind === 'canonical-token') ||
    Date.parse(preparation.expiresAt) > Date.parse(preparation.credentialExpiresAt) ||
    (proof.authenticatedAt === null ? proof.linkGuarded : !proof.linkGuarded) ||
    (plan.provider === 'apple' && (proof.authenticatedAt !== null || proof.linkGuarded))
  )
    return refuse('invalid_proof');
}
async function validateCandidate(
  runtime: ProviderSecurityRuntime,
  preparation: AnonymousProviderPreparation,
  candidate: Payload<'finalize'>['candidate'],
  now: Date,
) {
  if (candidate.kind !== preparation.credentialKind || Date.parse(preparation.credentialExpiresAt) <= now.getTime())
    return refuse('invalid_proof');
  if (candidate.kind === 'canonical-token') {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(candidate.credential) ||
      providerCredentialHash(candidate) !== preparation.proposedCanonicalTokenHash
    )
      return refuse('invalid_proof');
    return { kind: 'canonical-token' as const, token: candidate.credential };
  }
  if (!runtime.legacySecret) return refuse('authority_unavailable', 'unavailable');
  const proof = await verifyLegacyNextAuthJwe(candidate.credential, runtime.legacySecret, now);
  const expected = preparation.credentialProof;
  if (
    !proof ||
    proof.userId !== expected.userId ||
    proof.authSessionId !== expected.authSessionId ||
    proof.generation !== expected.generation ||
    proof.linkGuarded !== expected.linkGuarded ||
    proof.requiresAccountCutoff ||
    (proof.linkGuarded ? (proof.originalAuthenticatedAt?.toISOString() ?? null) : null) !== expected.authenticatedAt ||
    proof.expiresAt.toISOString() !== preparation.credentialExpiresAt
  )
    return refuse('invalid_proof');
  return { kind: 'legacy-jwe' as const, credential: candidate.credential, secret: runtime.legacySecret };
}

/** Requires a positive exact anonymous binding; missing/refused actors never enter this API. */
export async function beginAnonymousProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  requested: Payload<'intent'>,
) {
  const input = capture('intent', requested);
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  if (!runtime.methods.configuredProviders.includes(input.provider)) return refuse('provider_unavailable');
  const browser = await beginAnonymousBrowserIntent(database, runtime.qualification, input.browser);
  if (browser.status !== 'prepared')
    return refuse('invalid_proof', browser.status === 'unavailable' ? 'unavailable' : 'identity_changed');
  const intentToken = randomBytes(32).toString('base64url');
  const bound = { ...input, intentToken, browserIntentToken: browser.intentToken };
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const cursor = await anonymous(transaction, authority, input.browser);
    const now = await providerDatabaseNow(transaction);
    const login = await browserIntent(transaction, authority, bound, cursor, now);
    const expiresAt = new Date(Math.min(login.expiresAt.getTime(), cursor.bindingExpiresAt.getTime()));
    await transaction.insert(authWebOAuthIntents).values({
      intentHash: flowId(intentToken),
      provider: input.provider,
      flowHash: flowBinding(bound, input.provider, input.credentialKind, authority, cursor),
      actorUserId: null,
      actorLineageHash: null,
      actorObservedGeneration: null,
      issuedAt: now,
      expiresAt,
    });
    if ((await providerDatabaseNow(transaction)).getTime() >= expiresAt.getTime()) return refuse('expired');
    return {
      outcome: 'recorded' as const,
      intentToken,
      browserIntentToken: browser.intentToken,
      browserCursor: cursor,
      expiresAt,
    };
  });
}

export async function prepareAnonymousProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  requested: Payload<'prepare'>,
) {
  const input = capture('prepare', requested);
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const assertion = input.providerProof;
  if (!runtime.methods.configuredProviders.includes(assertion.provider)) return refuse('provider_unavailable');
  if (
    assertion.provider === 'apple'
      ? assertion.idToken !== null || assertion.nonce !== null
      : assertion.idToken === null || assertion.nonce === null || providerTokenHash(assertion.nonce) !== input.nonceHash
  )
    return refuse('invalid_proof');
  const beforeVerification = await readIdentityAuthority(database, runtime.qualification);
  const google =
    assertion.provider === 'google'
      ? await verifyProviderGoogleAuthenticationAssertion(runtime.methods, {
          idToken: assertion.idToken!,
          nonce: assertion.nonce!,
        }).catch(() => null)
      : null;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    await revalidateIdentityAuthority(transaction, beforeVerification);
    // Subject/target user/email locks precede the binding. The strict anonymous
    // reader will never acquire a newly discovered selected owner's user lock.
    const planned = await planReservedCurrentStoreOAuthIdentity(
      transaction,
      expectedAuthority(authority),
      assertion.provider,
      assertion.identity,
      policy,
      undefined,
      authority,
    );
    if (planned.outcome !== 'planned') return refuse('ownership_conflict');
    const cursor = await anonymous(transaction, authority, input.browser);
    const now = await providerDatabaseNow(transaction);
    const login = await browserIntent(transaction, authority, input, cursor, now);
    const flow = await initialFlow(transaction, authority, input, input.credentialKind, cursor);
    if (flow.provider !== assertion.provider || flow.consumedAt !== null) return refuse('replayed');
    const authenticatedAt =
      google?.subject === assertion.identity.sub &&
      googleReauthenticationDeadline(google.authenticatedAt, google.expiresAt, now, flow.expiresAt)
        ? new Date(google.authenticatedAt * 1000).toISOString()
        : null;
    const credentialExpiresAt = new Date(
      Math.floor(
        Math.min(Math.floor(now.getTime() / 1000) * 1000 + 30 * 86_400_000, cursor.bindingExpiresAt.getTime()) / 1000,
      ) * 1000,
    );
    const expiresAt = new Date(
      Math.min(
        flow.expiresAt.getTime(),
        login.expiresAt.getTime(),
        cursor.bindingExpiresAt.getTime(),
        credentialExpiresAt.getTime(),
      ),
    );
    const proposedCanonicalToken =
      input.credentialKind === 'canonical-token' ? randomBytes(32).toString('base64url') : null;
    const preparation = anonymousProviderPreparationSchema.parse({
      credentialKind: input.credentialKind,
      identityPlan: planned.plan,
      verifiedIdentity: assertion.identity,
      credentialProof: {
        version: 1,
        userId: planned.plan.user.id,
        authSessionId: randomUUID(),
        generation: planned.plan.generation,
        authenticatedAt,
        linkGuarded: authenticatedAt !== null,
      },
      credentialExpiresAt: credentialExpiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      proposedCanonicalTokenHash: proposedCanonicalToken
        ? providerCredentialHash({ kind: 'canonical-token', credential: proposedCanonicalToken })
        : null,
    });
    requirePreparation(preparation);
    const preparationToken = randomBytes(32).toString('base64url');
    await consume(transaction, flow, now);
    await transaction.insert(authWebOAuthIntents).values({
      intentHash: preparationId(preparationToken),
      provider: flow.provider,
      flowHash: preparedBinding(input, preparation, authority, cursor),
      actorUserId: null,
      actorLineageHash: null,
      actorObservedGeneration: null,
      issuedAt: now,
      expiresAt,
    });
    if (
      (await providerDatabaseNow(transaction)).getTime() >=
      Math.min(expiresAt.getTime(), Date.parse(preparation.credentialExpiresAt))
    )
      return refuse('expired');
    return {
      outcome: 'prepared' as const,
      preparationToken,
      preparation,
      proposedCanonicalToken,
      browserCursor: cursor,
    };
  });
}

export async function finalizeAnonymousProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  requested: Payload<'finalize'>,
) {
  const input = capture('finalize', requested);
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const preparation = input.preparation;
  requirePreparation(preparation);
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const planned = await planReservedCurrentStoreOAuthIdentity(
      transaction,
      expectedAuthority(authority),
      preparation.identityPlan.provider,
      preparation.verifiedIdentity,
      policy,
      undefined,
      authority,
    );
    if (planned.outcome !== 'planned') return refuse('ownership_conflict');
    const [observed] = await transaction
      .select()
      .from(authWebOAuthIntents)
      .where(eq(authWebOAuthIntents.intentHash, preparationId(input.preparationToken)));
    const replayed = observed?.consumedAt !== null && observed?.consumedAt !== undefined;
    if (
      replayed
        ? planned.plan.kind !== 'existing' || !samePlan(preparation.identityPlan, planned.plan, true)
        : planned.plan.kind !== preparation.identityPlan.kind ||
          (planned.plan.kind === 'existing' && !samePlan(preparation.identityPlan, planned.plan))
    )
      return refuse('ownership_conflict');
    const now = await providerDatabaseNow(transaction);
    const credential = await validateCandidate(runtime, preparation, input.candidate, now);
    let cursor: BrowserBindingCursor;
    if (replayed) {
      const acknowledged = await acknowledgeAnonymousBrowserLoginInTransaction(transaction, authority, {
        ...input.browser,
        intentToken: input.browserIntentToken,
        expectedUserId: preparation.credentialProof.userId,
        expectedAuthSessionId: preparation.credentialProof.authSessionId,
        credential,
      });
      if (acknowledged.status !== 'already-committed')
        return refuse('invalid_proof', acknowledged.status === 'unavailable' ? 'unavailable' : 'identity_changed');
      cursor = acknowledged.cursor;
    } else cursor = await anonymous(transaction, authority, input.browser);
    const flow = await initialFlow(transaction, authority, input, preparation.credentialKind, cursor);
    const [prepared] = await transaction
      .select()
      .from(authWebOAuthIntents)
      .where(eq(authWebOAuthIntents.intentHash, preparationId(input.preparationToken)))
      .for('update');
    if (
      !prepared ||
      flow.consumedAt === null ||
      prepared.provider !== flow.provider ||
      prepared.actorUserId !== null ||
      prepared.actorLineageHash !== null ||
      prepared.actorObservedGeneration !== null ||
      prepared.flowHash !== preparedBinding(input, preparation, authority, cursor) ||
      prepared.issuedAt.getTime() !== flow.consumedAt.getTime() ||
      prepared.expiresAt.toISOString() !== preparation.expiresAt ||
      prepared.expiresAt.getTime() <= now.getTime()
    )
      return refuse('invalid_intent');
    if (!runtime.methods.configuredProviders.includes(preparation.identityPlan.provider))
      return refuse('provider_unavailable');
    if (replayed) {
      if (
        (await providerDatabaseNow(transaction)).getTime() >=
        Math.min(
          prepared.expiresAt.getTime(),
          Date.parse(preparation.credentialExpiresAt),
          cursor.bindingExpiresAt.getTime(),
        )
      )
        return refuse('expired');
      return {
        outcome: 'recovered' as const,
        candidateCredentialHash: providerCredentialHash(input.candidate),
        browserCursor: cursor,
      };
    }
    if (prepared.consumedAt !== null) return refuse('replayed');
    await browserIntent(transaction, authority, input, cursor, now);
    const applied = await applyReservedCurrentStoreOAuthIdentityPlan(
      transaction,
      expectedAuthority(authority),
      preparation.identityPlan.provider,
      preparation.verifiedIdentity,
      policy,
      preparation.identityPlan,
      undefined,
      authority,
    );
    if (applied.outcome !== (preparation.identityPlan.kind === 'new' ? 'created' : 'linked'))
      return refuse('ownership_conflict');
    if (input.candidate.kind === 'canonical-token')
      await transaction.insert(authSession).values({
        id: preparation.credentialProof.authSessionId,
        userId: preparation.credentialProof.userId,
        token: input.candidate.credential,
        expiresAt: new Date(preparation.credentialExpiresAt),
        updatedAt: now,
        revocationGeneration: preparation.credentialProof.generation,
        originalAuthenticatedAt: preparation.credentialProof.authenticatedAt
          ? new Date(preparation.credentialProof.authenticatedAt)
          : null,
      });
    const browser = await commitBrowserLoginInTransaction(
      transaction,
      authority,
      input.browser.bindingToken,
      input.browserIntentToken,
      credential,
    );
    if (browser.status !== 'committed')
      return refuse('invalid_proof', browser.status === 'unavailable' ? 'unavailable' : 'identity_changed');
    await consume(transaction, prepared, await providerDatabaseNow(transaction));
    if (
      (await providerDatabaseNow(transaction)).getTime() >=
      Math.min(
        prepared.expiresAt.getTime(),
        Date.parse(preparation.credentialExpiresAt),
        cursor.bindingExpiresAt.getTime(),
      )
    )
      return refuse('expired');
    return {
      outcome: 'committed' as const,
      candidateCredentialHash: providerCredentialHash(input.candidate),
      browserCursor: browser.cursor,
    };
  });
}

export async function abortAnonymousProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  requested: Payload<'abort'>,
) {
  const input = capture('abort', requested);
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  if ((input.preparationToken === null) !== (input.preparation === null)) return refuse('invalid_intent');
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const cursor = await anonymous(transaction, authority, input.browser);
    const now = await providerDatabaseNow(transaction);
    const login = await browserIntent(transaction, authority, input, cursor, now, true);
    const flow = await initialFlow(transaction, authority, input, input.credentialKind, cursor);
    if (flow.consumedAt === null) await consume(transaction, flow, now);
    if (input.preparationToken && input.preparation) {
      const [prepared] = await transaction
        .select()
        .from(authWebOAuthIntents)
        .where(eq(authWebOAuthIntents.intentHash, preparationId(input.preparationToken)))
        .for('update');
      if (!prepared || prepared.flowHash !== preparedBinding(input, input.preparation, authority, cursor))
        return refuse('invalid_intent');
      if (prepared.consumedAt === null) await consume(transaction, prepared, now);
    }
    if (login.consumedAt === null)
      await transaction
        .update(authBrowserIntents)
        .set({ consumedAt: now, resultVersion: login.expectedVersion + 1 })
        .where(and(eq(authBrowserIntents.id, login.id), isNull(authBrowserIntents.consumedAt)));
    if (
      (await providerDatabaseNow(transaction)).getTime() >=
      Math.min(flow.expiresAt.getTime(), cursor.bindingExpiresAt.getTime())
    )
      return refuse('expired');
    return { outcome: 'aborted' as const };
  });
}

export async function executeAnonymousProviderCommand(
  database: AuthorityDatabase,
  runtime: ProviderSecurityRuntime,
  requested: AnonymousProviderCommand,
): Promise<AnonymousProviderReply> {
  const command = anonymousProviderCommandSchema.parse(requested);
  if (!isWebPasswordCommandFresh(Date.parse(command.issuedAt))) return refuse('expired');
  let result: unknown;
  try {
    switch (command.operation) {
      case 'intent':
        result = await beginAnonymousProviderSignin(database, runtime, command.payload);
        break;
      case 'prepare':
        result = await prepareAnonymousProviderSignin(database, runtime, command.payload);
        break;
      case 'finalize':
        result = await finalizeAnonymousProviderSignin(database, runtime, command.payload);
        break;
      case 'abort':
        result = await abortAnonymousProviderSignin(database, runtime, command.payload);
        break;
    }
  } catch (error) {
    if (error instanceof ProviderSecurityRefusal) result = { outcome: error.outcome, code: error.code };
    else throw error;
  }
  return anonymousProviderReplySchema.parse(
    JSON.parse(
      JSON.stringify({
        anonymousProviderVersion: 1,
        requestId: command.requestId,
        operation: command.operation,
        ...(result as Record<string, unknown>),
      }),
    ),
  );
}
