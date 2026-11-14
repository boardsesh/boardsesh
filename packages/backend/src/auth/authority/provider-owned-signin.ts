import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  authBrowserBindings,
  authBrowserIntents,
  authSession,
  authWebOAuthIntents,
  users,
} from '@boardsesh/db/schema/auth';
import {
  providerOwnedSigninPreparationSchema,
  type ProviderOwnedSigninPreparation,
  type ProviderSecurityCommand,
  type WebCredentialProof,
} from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  beginBrowserIntent,
  commitBrowserLoginInTransaction,
  readBrowserBindingInTransaction,
  type BrowserBindingCursor,
} from './browser-binding';
import { bindIdentityAuthority } from './identity-authority';
import { lockProviderSubject, lockSubjectRow } from '../current-store/foundation-context';
import { readLockedWebSubjectState } from '../current-store/web-credential-state';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import { readFirstPartySession, type FirstPartySession } from './session-reader';
import { readIdentityAuthority, revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';
import { providerCredentialHash, type ProviderCandidateCredential } from './provider-security-result';
import {
  admitProviderActorInTransaction,
  captureProviderActor,
  providerDatabaseNow,
  providerTokenHash,
  ProviderSecurityRefusal,
  type CapturedProviderActor,
} from './provider-security-context';
import {
  captureProviderSecurityRuntime,
  withProviderSecurityAuthority,
  type ProviderSecurityRuntime,
} from './provider-security-intents';
import { googleReauthenticationDeadline } from './provider-security-policy';
import { verifyProviderGoogleAuthenticationAssertion } from './provider-google-reauthentication';

type Payload<Operation extends ProviderSecurityCommand['operation']> = Extract<
  ProviderSecurityCommand,
  { operation: Operation }
>['payload'];
type SigninBound = Omit<Payload<'signin-prepare'>, 'providerProof'>;
type FlowRow = typeof authWebOAuthIntents.$inferSelect;
const hash = (parts: readonly unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const flowId = (token: string) => hash(['provider-owned-signin-flow-v1', token]);
const preparationId = (token: string) => hash(['provider-owned-signin-preparation-v1', token]);

function actorBinding(actor: CapturedProviderActor, session: FirstPartySession, cursor: BrowserBindingCursor): string {
  return hash([
    'provider-owned-signin-actor-v1',
    actor.input.kind,
    actor.credentialHash,
    session.userId,
    session.authSessionId,
    session.generation,
    session.authenticatedAt?.toISOString() ?? null,
    session.linkGuarded,
    session.requiresAccountCutoff,
    session.expiresAt.toISOString(),
    cursor.bindingId,
    actor.input.browserVersion,
    cursor.bindingExpiresAt.toISOString(),
  ]);
}
function flowBinding(input: SigninBound, provider: string, authority: IdentityAuthorityReceipt): string {
  return hash([
    'provider-owned-signin-flow-binding-v1',
    provider,
    input.flowHash,
    input.nonceHash,
    providerTokenHash(input.browserIntentToken),
    authority.projectionId,
    authority.normalizerVersion,
    authority.authority,
    authority.epoch,
  ]);
}
function preparedBinding(
  input: SigninBound,
  preparation: ProviderOwnedSigninPreparation,
  authority: IdentityAuthorityReceipt,
): string {
  return hash([
    'provider-owned-signin-prepared-binding-v1',
    flowId(input.intentToken),
    flowBinding(input, preparation.provider, authority),
    preparation,
  ]);
}
function proofFor(session: FirstPartySession): WebCredentialProof {
  return {
    version: 1,
    userId: session.userId,
    authSessionId: session.authSessionId,
    generation: session.generation,
    authenticatedAt: session.authenticatedAt?.toISOString() ?? null,
    linkGuarded: session.linkGuarded,
    ...(session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
  };
}
function userFor(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
  };
}
function capturedBound(input: SigninBound): SigninBound {
  return Object.freeze({ ...input, actor: Object.freeze({ ...input.actor }) });
}
async function browserLoginIntent(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  actor: CapturedProviderActor,
  browserIntentToken: string,
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
        eq(authBrowserIntents.id, providerTokenHash(browserIntentToken)),
        eq(authBrowserBindings.id, cursor.bindingId),
      ),
    )
    .for('update', { of: authBrowserIntents });
  const canceled =
    allowCanceled &&
    observed?.intent.consumedAt !== null &&
    observed?.intent.resultVersion === actor.input.browserVersion + 1 &&
    observed?.intent.resultCredentialHash === null;
  if (
    !observed ||
    observed.intent.operation !== 'login' ||
    observed.intent.formatVersion !== 2 ||
    observed.intent.expectedVersion !== actor.input.browserVersion ||
    observed.intent.revision !== observed.revision ||
    (!canceled &&
      (observed.intent.consumedAt !== null ||
        observed.intent.resultVersion !== null ||
        observed.intent.resultCredentialHash !== null)) ||
    observed.intent.expiresAt.getTime() <= now.getTime() ||
    observed.intent.projectionId !== authority.projectionId ||
    observed.intent.authority !== authority.authority ||
    observed.intent.epoch !== authority.epoch
  )
    throw new ProviderSecurityRefusal('denied', 'invalid_intent');
  return observed.intent;
}
async function initialFlow(
  transaction: AuthorityTransaction,
  input: SigninBound,
  authority: IdentityAuthorityReceipt,
  actor: CapturedProviderActor,
  session: FirstPartySession,
  cursor: BrowserBindingCursor,
) {
  const [row] = await transaction
    .select()
    .from(authWebOAuthIntents)
    .where(eq(authWebOAuthIntents.intentHash, flowId(input.intentToken)))
    .for('update');
  if (!row) throw new ProviderSecurityRefusal('denied', 'invalid_intent');
  if (
    row.actorUserId !== session.userId ||
    row.actorObservedGeneration !== session.generation ||
    row.actorLineageHash !== actorBinding(actor, session, cursor)
  )
    throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  if (row.flowHash !== flowBinding(input, row.provider, authority))
    throw new ProviderSecurityRefusal('denied', 'invalid_intent');
  if (row.expiresAt.getTime() <= (await providerDatabaseNow(transaction)).getTime())
    throw new ProviderSecurityRefusal('denied', 'expired');
  return row;
}
async function consume(transaction: AuthorityTransaction, row: FlowRow, now: Date) {
  const [consumed] = await transaction
    .update(authWebOAuthIntents)
    .set({ consumedAt: now })
    .where(and(eq(authWebOAuthIntents.intentHash, row.intentHash), isNull(authWebOAuthIntents.consumedAt)))
    .returning();
  if (!consumed) throw new ProviderSecurityRefusal('denied', 'replayed');
}

/** Namespaced ordinary login flow. No identity or credential is written here. */
export async function beginOwnedProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: Payload<'signin-intent'>,
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const actor = captureProviderActor(input.actor, runtime.legacySecret);
  const { provider, flowHash, nonceHash } = input;
  if (!runtime.methods.configuredProviders.includes(provider))
    throw new ProviderSecurityRefusal('denied', 'provider_unavailable');
  const browser = await beginBrowserIntent(database, runtime.qualification, actor.input.browserBindingToken, {
    operation: 'login',
    expectedVersion: actor.input.browserVersion,
    expectedIdentity: { userId: actor.input.expectedUserId, authSessionId: actor.input.expectedAuthSessionId },
    presented: { version: actor.input.browserVersion, credential: actor.credential },
  });
  if (browser.status !== 'prepared')
    throw new ProviderSecurityRefusal(
      browser.status === 'unavailable' ? 'unavailable' : 'identity_changed',
      browser.status === 'unavailable' ? 'authority_unavailable' : 'invalid_proof',
    );
  const intentToken = randomBytes(32).toString('base64url');
  const bound = { actor: actor.input, intentToken, browserIntentToken: browser.intentToken, flowHash, nonceHash };
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const { session, cursor } = await admitProviderActorInTransaction(transaction, authority, actor);
    const now = await providerDatabaseNow(transaction);
    const login = await browserLoginIntent(transaction, authority, actor, browser.intentToken, cursor, now);
    const expiresAt = new Date(
      Math.min(login.expiresAt.getTime(), session.expiresAt.getTime(), cursor.bindingExpiresAt.getTime()),
    );
    await transaction.insert(authWebOAuthIntents).values({
      intentHash: flowId(intentToken),
      provider,
      flowHash: flowBinding(bound, provider, authority),
      actorUserId: session.userId,
      actorLineageHash: actorBinding(actor, session, cursor),
      actorObservedGeneration: session.generation,
      issuedAt: now,
      expiresAt,
    });
    if ((await providerDatabaseNow(transaction)).getTime() >= expiresAt.getTime())
      throw new ProviderSecurityRefusal('denied', 'expired');
    return {
      outcome: 'recorded' as const,
      intentToken,
      browserIntentToken: browser.intentToken,
      browserCursor: cursor,
      expiresAt,
    };
  });
}

/** The private web delegate has verified provider/subject. Only separately
 * verified Google auth_time may grant age; callback/issue time never does. */
export async function prepareOwnedProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: Payload<'signin-prepare'>,
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const bound = capturedBound(input);
  const actor = captureProviderActor(bound.actor, runtime.legacySecret);
  const providerProof = Object.freeze({ ...input.providerProof });
  const beforeVerification = await readIdentityAuthority(database, runtime.qualification);
  const google =
    providerProof.provider === 'google' &&
    providerProof.idToken &&
    providerProof.nonce &&
    bound.nonceHash === providerTokenHash(providerProof.nonce)
      ? await verifyProviderGoogleAuthenticationAssertion(runtime.methods, {
          idToken: providerProof.idToken,
          nonce: providerProof.nonce,
        }).catch(() => null)
      : null;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    await revalidateIdentityAuthority(transaction, beforeVerification);
    await lockProviderSubject(transaction, providerProof.provider, providerProof.subject);
    const identity = bindIdentityAuthority(transaction, authority);
    const observed = await identity.findProvider(providerProof.provider, providerProof.subject);
    for (const userId of [...new Set([actor.input.expectedUserId, ...(observed ? [observed.userId] : [])])].sort())
      await lockSubjectRow(transaction, userId);
    const { session, cursor } = await admitProviderActorInTransaction(transaction, authority, actor);
    const row = await initialFlow(transaction, bound, authority, actor, session, cursor);
    if (row.consumedAt !== null) throw new ProviderSecurityRefusal('denied', 'replayed');
    if (
      row.provider !== providerProof.provider ||
      (providerProof.nonce !== null && bound.nonceHash !== providerTokenHash(providerProof.nonce))
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    let now = await providerDatabaseNow(transaction);
    await browserLoginIntent(transaction, authority, actor, bound.browserIntentToken, cursor, now);
    const owner = await identity.findProvider(providerProof.provider, providerProof.subject, 'update');
    // Unknown subjects cannot consume an ordinary flow or become implicit links.
    if (!observed || !owner || owner.userId !== observed.userId || owner.generation !== observed.generation)
      throw new ProviderSecurityRefusal('denied', 'ownership_conflict');
    const targetState = await readLockedWebSubjectState(transaction, owner.userId);
    if (!targetState || owner.generation !== targetState.generation)
      throw new ProviderSecurityRefusal('denied', 'ownership_conflict');
    const [user] = await transaction.select().from(users).where(eq(users.id, owner.userId));
    if (!user) throw new ProviderSecurityRefusal('denied', 'ownership_conflict');
    if (!runtime.methods.configuredProviders.includes(providerProof.provider))
      throw new ProviderSecurityRefusal('denied', 'provider_unavailable');
    now = await providerDatabaseNow(transaction);
    if (
      now.getTime() >= Math.min(row.expiresAt.getTime(), session.expiresAt.getTime(), cursor.bindingExpiresAt.getTime())
    )
      throw new ProviderSecurityRefusal('denied', 'expired');
    await consume(transaction, row, now);
    if (
      (await providerDatabaseNow(transaction)).getTime() >=
      Math.min(row.expiresAt.getTime(), session.expiresAt.getTime(), cursor.bindingExpiresAt.getTime())
    )
      throw new ProviderSecurityRefusal('denied', 'expired');
    if (owner.userId === session.userId)
      return {
        outcome: 'same-owner' as const,
        credentialProof: proofFor(session),
        credentialExpiresAt: session.expiresAt,
        browserCursor: cursor,
        user: userFor(user),
      };
    const authenticatedAt =
      google?.subject === owner.subject &&
      googleReauthenticationDeadline(google.authenticatedAt, google.expiresAt, now, row.expiresAt)
        ? new Date(google.authenticatedAt * 1000).toISOString()
        : null;
    const proposedCanonicalToken =
      actor.input.kind === 'canonical-token' ? randomBytes(32).toString('base64url') : null;
    const preparationToken = randomBytes(32).toString('base64url');
    const preparation = providerOwnedSigninPreparationSchema.parse({
      provider: providerProof.provider,
      subject: providerProof.subject,
      credentialProof: {
        version: 1,
        userId: owner.userId,
        authSessionId: randomUUID(),
        generation: owner.generation,
        authenticatedAt,
        linkGuarded: authenticatedAt !== null,
      },
      // A distinct ordinary login receives the usual bounded session lifetime;
      // it never changes A's age/expiry or supplies a provider-mutation receipt.
      credentialExpiresAt: new Date(
        Math.floor(
          Math.min(Math.floor(now.getTime() / 1000) * 1000 + 30 * 86_400_000, cursor.bindingExpiresAt.getTime()) / 1000,
        ) * 1000,
      ).toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      proposedCanonicalTokenHash: proposedCanonicalToken
        ? providerCredentialHash({ kind: 'canonical-token', credential: proposedCanonicalToken })
        : null,
    });
    await transaction.insert(authWebOAuthIntents).values({
      intentHash: preparationId(preparationToken),
      provider: row.provider,
      flowHash: preparedBinding(bound, preparation, authority),
      actorUserId: row.actorUserId,
      actorLineageHash: row.actorLineageHash,
      actorObservedGeneration: row.actorObservedGeneration,
      issuedAt: now,
      expiresAt: row.expiresAt,
    });
    if (
      (await providerDatabaseNow(transaction)).getTime() >=
      Math.min(row.expiresAt.getTime(), session.expiresAt.getTime(), cursor.bindingExpiresAt.getTime())
    )
      throw new ProviderSecurityRefusal('denied', 'expired');
    return {
      outcome: 'prepared' as const,
      preparationToken,
      preparation,
      proposedCanonicalToken,
      browserCursor: cursor,
      user: userFor(user),
    };
  });
}

async function validateSigninCandidate(
  preparation: ProviderOwnedSigninPreparation,
  candidate: ProviderCandidateCredential,
  actor: CapturedProviderActor,
  now: Date,
) {
  if (candidate.kind !== actor.input.kind) throw new ProviderSecurityRefusal('denied', 'invalid_proof');
  if (candidate.kind === 'canonical-token') {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(candidate.credential) ||
      providerCredentialHash(candidate) !== preparation.proposedCanonicalTokenHash
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_proof');
    return { kind: 'canonical-token' as const, token: candidate.credential };
  }
  if (actor.credential.kind !== 'legacy-jwe') throw new ProviderSecurityRefusal('denied', 'invalid_proof');
  const proof = await verifyLegacyNextAuthJwe(candidate.credential, actor.credential.secret, now);
  const expected = preparation.credentialProof;
  if (
    !proof ||
    proof.userId !== expected.userId ||
    proof.authSessionId !== expected.authSessionId ||
    proof.generation !== expected.generation ||
    proof.linkGuarded !== expected.linkGuarded ||
    proof.requiresAccountCutoff !== (expected.requiresAccountCutoff === true) ||
    (proof.linkGuarded ? (proof.originalAuthenticatedAt?.toISOString() ?? null) : null) !== expected.authenticatedAt ||
    proof.expiresAt.toISOString() !== preparation.credentialExpiresAt
  )
    throw new ProviderSecurityRefusal('denied', 'invalid_proof');
  return { kind: 'legacy-jwe' as const, credential: candidate.credential, secret: actor.credential.secret };
}

/** Call only after ALL response bytes/hooks/admission/cookies are buffered.
 * Every refusal after credential insertion throws out of this whole transaction. */
export async function finalizeOwnedProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: Payload<'signin-finalize'>,
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const bound = capturedBound(input);
  const actor = captureProviderActor(bound.actor, runtime.legacySecret);
  const preparation = providerOwnedSigninPreparationSchema.parse(input.preparation);
  const { preparationToken } = input;
  const candidate = Object.freeze({ ...input.candidate });
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    await lockProviderSubject(transaction, preparation.provider, preparation.subject);
    const identity = bindIdentityAuthority(transaction, authority);
    const observed = await identity.findProvider(preparation.provider, preparation.subject);
    for (const userId of [...new Set([actor.input.expectedUserId, preparation.credentialProof.userId])].sort())
      await lockSubjectRow(transaction, userId);
    const [observedPreparation] = await transaction
      .select()
      .from(authWebOAuthIntents)
      .where(eq(authWebOAuthIntents.intentHash, preparationId(preparationToken)));
    const now = await providerDatabaseNow(transaction);
    const credential = await validateSigninCandidate(preparation, candidate, actor, now);
    const replayed = observedPreparation?.consumedAt !== null && observedPreparation?.consumedAt !== undefined;
    let session: FirstPartySession;
    let cursor: BrowserBindingCursor;
    if (replayed) {
      // ACK only: caller must retain the exact candidate. Old actor+flow cannot
      // retrieve/reconstruct any B bearer or move a later primary selection.
      const selected = await readBrowserBindingInTransaction(transaction, authority, {
        bindingToken: actor.input.browserBindingToken,
        actor: { version: actor.input.browserVersion + 1, credential },
      });
      const previous = await readFirstPartySession(transaction, actor.credential, now, (userId) =>
        readLockedWebSubjectState(transaction, userId),
      );
      if (selected.status === 'unavailable' || previous.status === 'unavailable')
        throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
      if (
        selected.status !== 'admitted' ||
        previous.status !== 'admitted' ||
        previous.session.userId !== actor.input.expectedUserId ||
        previous.session.authSessionId !== actor.input.expectedAuthSessionId
      )
        throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
      session = previous.session;
      cursor = selected.cursor;
    } else ({ session, cursor } = await admitProviderActorInTransaction(transaction, authority, actor));
    const row = await initialFlow(transaction, bound, authority, actor, session, cursor);
    const [prepared] = await transaction
      .select()
      .from(authWebOAuthIntents)
      .where(eq(authWebOAuthIntents.intentHash, preparationId(preparationToken)))
      .for('update');
    if (
      !prepared ||
      row.consumedAt === null ||
      prepared.provider !== preparation.provider ||
      prepared.actorUserId !== row.actorUserId ||
      prepared.actorObservedGeneration !== row.actorObservedGeneration ||
      prepared.actorLineageHash !== row.actorLineageHash ||
      prepared.flowHash !== preparedBinding(bound, preparation, authority) ||
      prepared.expiresAt.getTime() <= now.getTime() ||
      prepared.issuedAt.getTime() !== row.consumedAt.getTime() ||
      preparation.expiresAt !== prepared.expiresAt.toISOString()
    )
      throw new ProviderSecurityRefusal('denied', 'invalid_intent');
    if (!replayed) await browserLoginIntent(transaction, authority, actor, bound.browserIntentToken, cursor, now);
    const owner = await identity.findProvider(preparation.provider, preparation.subject, 'update');
    const targetState = await readLockedWebSubjectState(transaction, preparation.credentialProof.userId);
    if (
      !observed ||
      !owner ||
      owner.userId !== observed.userId ||
      owner.generation !== observed.generation ||
      owner.userId !== preparation.credentialProof.userId ||
      owner.generation !== preparation.credentialProof.generation ||
      !targetState ||
      targetState.generation !== owner.generation
    )
      throw new ProviderSecurityRefusal('denied', 'ownership_conflict');
    if (!runtime.methods.configuredProviders.includes(preparation.provider))
      throw new ProviderSecurityRefusal('denied', 'provider_unavailable');
    if (!replayed && candidate.kind === 'canonical-token')
      await transaction.insert(authSession).values({
        id: preparation.credentialProof.authSessionId,
        userId: owner.userId,
        token: candidate.credential,
        expiresAt: new Date(preparation.credentialExpiresAt),
        updatedAt: now,
        revocationGeneration: owner.generation,
        originalAuthenticatedAt: preparation.credentialProof.authenticatedAt
          ? new Date(preparation.credentialProof.authenticatedAt)
          : null,
      });
    const browser = await commitBrowserLoginInTransaction(
      transaction,
      authority,
      actor.input.browserBindingToken,
      bound.browserIntentToken,
      credential,
      { version: actor.input.browserVersion, credential: actor.credential },
    );
    if (browser.status !== 'committed' && browser.status !== 'already-committed')
      throw new ProviderSecurityRefusal(
        browser.status === 'unavailable' ? 'unavailable' : 'identity_changed',
        browser.status === 'unavailable' ? 'authority_unavailable' : 'invalid_proof',
      );
    if (!replayed) await consume(transaction, prepared, await providerDatabaseNow(transaction));
    if (
      (await providerDatabaseNow(transaction)).getTime() >=
      Math.min(
        prepared.expiresAt.getTime(),
        Date.parse(preparation.credentialExpiresAt),
        session.expiresAt.getTime(),
        cursor.bindingExpiresAt.getTime(),
      )
    )
      throw new ProviderSecurityRefusal('denied', 'expired');
    return {
      outcome: replayed ? ('recovered' as const) : ('committed' as const),
      candidateCredentialHash: providerCredentialHash(candidate),
      browserCursor: browser.cursor,
    };
  });
}

/** Cancel the exact browser login even when a lost prepare reply leaves its
 * preparation unknown. The mandated result version does not move the binding;
 * a NULL result hash cannot acknowledge any committed login candidate. */
export async function abortOwnedProviderSignin(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: Payload<'signin-abort'>,
) {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const bound = capturedBound(input);
  const actor = captureProviderActor(bound.actor, runtime.legacySecret);
  const { preparationToken } = input;
  const preparation = input.preparation ? providerOwnedSigninPreparationSchema.parse(input.preparation) : null;
  return withProviderSecurityAuthority(database, runtime, async (transaction, authority) => {
    const { session, cursor } = await admitProviderActorInTransaction(transaction, authority, actor);
    const row = await initialFlow(transaction, bound, authority, actor, session, cursor);
    const now = await providerDatabaseNow(transaction);
    if (!row.consumedAt) await consume(transaction, row, now);
    if (preparationToken || preparation) {
      if (!preparationToken || !preparation) throw new ProviderSecurityRefusal('denied', 'invalid_intent');
      const [prepared] = await transaction
        .select()
        .from(authWebOAuthIntents)
        .where(eq(authWebOAuthIntents.intentHash, preparationId(preparationToken)))
        .for('update');
      if (
        !prepared ||
        prepared.actorLineageHash !== row.actorLineageHash ||
        prepared.flowHash !== preparedBinding(bound, preparation, authority)
      )
        throw new ProviderSecurityRefusal('denied', 'invalid_intent');
      if (!prepared.consumedAt) await consume(transaction, prepared, now);
    }
    const login = await browserLoginIntent(transaction, authority, actor, bound.browserIntentToken, cursor, now, true);
    if (login.consumedAt === null)
      await transaction
        .update(authBrowserIntents)
        .set({ consumedAt: now, resultVersion: login.expectedVersion + 1 })
        .where(and(eq(authBrowserIntents.id, login.id), isNull(authBrowserIntents.consumedAt)));
    return { outcome: 'aborted' as const };
  });
}
