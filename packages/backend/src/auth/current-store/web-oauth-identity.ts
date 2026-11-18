import { readFirstPartySession } from '../authority/session-reader';
import { readLockedWebSubjectState } from './web-credential-state';
import { issueWebCredentialProof } from './web-credential-proof';
import { createHash } from 'node:crypto';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import { authSubjectCutoffs, authWebOAuthCommands, authWebOAuthIntents, users } from '@boardsesh/db/schema/auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_COMMAND_MAX_AGE_MS,
  AUTH_COMMAND_TIMEOUT_MS,
  WEB_OAUTH_GOOGLE_NONCE_DOMAIN,
  WEB_OAUTH_PROTOCOL_VERSION,
  providerSecurityMode,
  webOAuthProviderSchema,
  webOAuthIntentReplySchema,
  webOAuthResolveReplySchema,
  type WebOAuthCommand,
  type WebOAuthIntentCommand,
  type WebOAuthResolveCommand,
  type WebOAuthResolveDenialCode,
  type WebOAuthIntentReply,
  type WebOAuthResolveReply,
  type WebOAuthSessionRequest,
} from '@boardsesh/auth-protocol';
import { assertFresh, transactionSettings } from './command-context';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  lockProviderSubject,
  lockSubjectRow,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';
import { readNegativeWebOAuthActor, webOAuthActorStillValid, type NegativeWebOAuthActor } from './web-oauth-actor';
import { resolveReservedCurrentStoreOAuthIdentity } from './provider-oauth-identity';
import { readIdentityAuthority, revalidateIdentityAuthority } from '../authority/router';
import { bindIdentityAuthority } from '../authority/identity-authority';
import { issueWebSession, lockWebSessionAccounts, readPresentedWebSession } from '../authority/web-session';
import type { FirstPartySession } from '../authority/session-reader';
import {
  verifyProviderGoogleAuthenticationAssertion,
  type VerifiedGoogleAuthenticationAssertion,
} from '../authority/provider-google-reauthentication';
import {
  captureProviderSecurityMethodsConfiguration,
  googleReauthenticationDeadline,
} from '../authority/provider-security-policy';

export const WEB_OAUTH_INTENT_LIFETIME_MS = 15 * 60_000;
type Unavailable = { readonly outcome: 'unavailable' };
type Intent = typeof authWebOAuthIntents.$inferSelect;

function digest(parts: readonly string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function denied<
  Operation extends 'intent' | 'resolve',
  Code extends WebOAuthResolveDenialCode = 'identity_unavailable',
>(operation: Operation, requestId: string, code: Code = 'identity_unavailable' as Code) {
  return {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation,
    requestId,
    outcome: 'denied',
    code,
  } as const;
}
async function nowMilliseconds(transaction: CurrentStoreTransaction) {
  const row = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  const milliseconds = Number(row?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error('Web OAuth clock unavailable');
  return milliseconds;
}
async function claim(
  transaction: CurrentStoreTransaction,
  command: Pick<WebOAuthCommand, 'issuedAt' | 'operation' | 'requestId'>,
) {
  const issuedAt = Date.parse(command.issuedAt);
  assertFresh(issuedAt);
  const inserted = await transaction
    .insert(authWebOAuthCommands)
    .values({
      commandHash: digest(['web-oauth-command-v1', command.requestId.toLowerCase()]),
      operation: command.operation,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(issuedAt + AUTH_COMMAND_MAX_AGE_MS + AUTH_COMMAND_FUTURE_SKEW_MS + AUTH_COMMAND_TIMEOUT_MS),
    })
    .onConflictDoNothing()
    .returning({ commandHash: authWebOAuthCommands.commandHash });
  return inserted.length === 1;
}
async function captureActor(cookie: string | null, secret: string) {
  try {
    return { actor: await readNegativeWebOAuthActor(cookie, secret), valid: true };
  } catch {
    return { actor: null, valid: false };
  }
}
async function actorGeneration(transaction: CurrentStoreTransaction, actor: NegativeWebOAuthActor | null) {
  if (!actor) return { valid: true, generation: null };
  const user = await lockSubjectRow(transaction, actor.userId);
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, actor.userId))
    .for('update');
  return { valid: Boolean(user) && !cutoff?.deletedAt, generation: cutoff?.generation ?? 0 };
}
function sameBinding(before: Intent, after: Intent) {
  return (
    before.intentHash === after.intentHash &&
    before.provider === after.provider &&
    before.flowHash === after.flowHash &&
    before.actorUserId === after.actorUserId &&
    before.actorLineageHash === after.actorLineageHash &&
    before.actorObservedGeneration === after.actorObservedGeneration &&
    before.issuedAt.getTime() === after.issuedAt.getTime() &&
    before.expiresAt.getTime() === after.expiresAt.getTime()
  );
}

/**
 * A Google sign-in counts as fresh only with a signed `auth_time` the backend
 * verifies itself (`CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE`), for this
 * subject, with a nonce bound into this intent's flow. Anything else is
 * `fresh: null`: the session is then `carried`. A verified token for another
 * subject means www is confused about who signed in: `subjectMismatch`, and
 * the sign-in is denied. An invalid mode value throws (fail closed).
 */
async function verifyFreshGoogleSignIn(
  provider: string,
  flow: string,
  subject: string,
  request: WebOAuthSessionRequest | undefined,
): Promise<{ readonly fresh: VerifiedGoogleAuthenticationAssertion | null; readonly subjectMismatch: boolean }> {
  const none = { fresh: null, subjectMismatch: false } as const;
  const proof = request?.googleAuthentication;
  if (provider !== 'google' || !proof) return none;
  const configuration = captureProviderSecurityMethodsConfiguration(process.env);
  if (!configuration.googleReauthenticationEnabled) return none;
  if (digest([WEB_OAUTH_GOOGLE_NONCE_DOMAIN, proof.nonce]) !== flow) return none;
  let assertion: VerifiedGoogleAuthenticationAssertion | null;
  try {
    assertion = await verifyProviderGoogleAuthenticationAssertion(configuration, {
      idToken: proof.idToken,
      nonce: proof.nonce,
    });
  } catch {
    return none;
  }
  if (!assertion) return none;
  return assertion.subject === subject
    ? { fresh: assertion, subjectMismatch: false }
    : { fresh: null, subjectMismatch: true };
}

/** Trusted web verifies the provider; backend exclusively resolves and writes identity. */
export async function recordWebOAuthIntent(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
  nextAuthSecret: string,
  input: WebOAuthIntentCommand,
): Promise<WebOAuthIntentReply> {
  const configuredAuthority = captureExpectedAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const { provider, flow, actorCookie } = input.payload;
  if (!webOAuthProviderSchema.safeParse(provider).success) return denied('intent', requestId);
  const receipt = await readIdentityAuthority(database, configuredAuthority);
  const authority = { ...configuredAuthority, expectedWriterEpoch: receipt.epoch };
  const captured = await captureActor(actorCookie, nextAuthSecret);
  return database.transaction(async (transaction) => {
    const execute = async (): Promise<WebOAuthIntentReply> => {
      await transactionSettings(transaction);
      await lockEnforcedProjection(transaction, authority);
      await revalidateIdentityAuthority(transaction, receipt);
      if (!(await claim(transaction, { requestId, issuedAt, operation: 'intent' })))
        return denied('intent', requestId, 'replayed');
      assertFresh(Date.parse(issuedAt));
      if (!captured.valid || !webOAuthActorStillValid(captured.actor)) return denied('intent', requestId);
      const actor = await actorGeneration(transaction, captured.actor);
      if (!actor.valid || !webOAuthActorStillValid(captured.actor)) return denied('intent', requestId);
      const now = await nowMilliseconds(transaction);
      const expiresAt = new Date(now + WEB_OAUTH_INTENT_LIFETIME_MS);
      const inserted = await transaction
        .insert(authWebOAuthIntents)
        .values({
          intentHash: digest(['web-oauth-intent-v1', provider, flow]),
          provider,
          flowHash: flow,
          actorUserId: captured.actor?.userId ?? null,
          actorLineageHash: captured.actor?.lineageHash ?? null,
          actorObservedGeneration: actor.generation,
          issuedAt: new Date(now),
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ intentHash: authWebOAuthIntents.intentHash });
      if (inserted.length !== 1) return denied('intent', requestId, 'replayed');
      return webOAuthIntentReplySchema.parse({
        webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
        operation: 'intent',
        requestId,
        outcome: 'recorded',
        flow,
        expiresAt: expiresAt.toISOString(),
      });
    };
    const result = await execute();
    // Every committing result, including denials and nonce conflicts, passes
    // the final deadline fence after all row/uniqueness waits.
    assertFresh(Date.parse(issuedAt));
    if (!webOAuthActorStillValid(captured.actor)) throw new Error('Web OAuth actor expired before commit');
    await revalidateIdentityAuthority(transaction, receipt);
    return result;
  });
}

export async function resolveWebOAuthIdentity(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
  nextAuthSecret: string,
  input: WebOAuthResolveCommand,
): Promise<WebOAuthResolveReply | Unavailable> {
  const ownedActorOnly = providerSecurityMode(process.env) === 'backend-staging';
  const configuredAuthority = captureExpectedAuthority(authorityInput);
  const { requestId, issuedAt, credentialProofVersion } = input;
  const { provider, flow, actorCookie, subject, email, name, image } = input.payload;
  if (!webOAuthProviderSchema.safeParse(provider).success) return denied('resolve', requestId);
  // A sign-in that asks for a web session links nothing to the session it
  // arrived with: that session is presented only to be revoked.
  const sessionRequest = input.webSession
    ? Object.freeze({
        presented: input.webSession.presented && Object.freeze({ ...input.webSession.presented }),
        googleAuthentication:
          input.webSession.googleAuthentication && Object.freeze({ ...input.webSession.googleAuthentication }),
      })
    : undefined;
  // And a session is never issued without the credential proof that gives
  // its legacy rollback cookie the same session id (#7596 B5a review, M1).
  if (sessionRequest && (actorCookie !== null || credentialProofVersion === undefined))
    return denied('resolve', requestId);
  // Network verification before any transaction or lock.
  const google = await verifyFreshGoogleSignIn(provider, flow, subject, sessionRequest);
  if (google.subjectMismatch) return denied('resolve', requestId);
  const freshGoogle = google.fresh;
  const receipt = await readIdentityAuthority(database, configuredAuthority);
  const authority = { ...configuredAuthority, expectedWriterEpoch: receipt.epoch };
  const captured = await captureActor(actorCookie, nextAuthSecret);
  const intentHash = digest(['web-oauth-intent-v1', provider, flow]);
  const [initial] = await database
    .select()
    .from(authWebOAuthIntents)
    .where(eq(authWebOAuthIntents.intentHash, intentHash));
  const before = initial
    ? { ...initial, issuedAt: new Date(initial.issuedAt), expiresAt: new Date(initial.expiresAt) }
    : undefined;
  return database.transaction(async (transaction) => {
    let presentedSession: FirstPartySession | undefined;
    let intentExpiresAt = new Date(0);
    /**
     * Issues the session for the resolved account, revoking the presented
     * one, and the rollback proof under the same session id and generation.
     * Google is a fresh `login` only with the verified `auth_time` above;
     * otherwise, and always for Apple, the session is `carried`, keeping this
     * sign-in's time without ever passing a five-minute check, and the proof
     * says so to www by `authenticatedAt: null, linkGuarded: false`, so the
     * legacy rollback cookie carries no `auth_time` either.
     */
    async function signInWithWebSession(
      locked: CurrentStoreTransaction,
      user: {
        id: string;
        email: string;
        name: string | null;
        image: string | null;
        emailVerified: Date | null;
        createdAt: Date;
      },
      createdUser: boolean,
    ): Promise<WebOAuthResolveReply> {
      const now = new Date(await nowMilliseconds(locked));
      const freshUntil = freshGoogle
        ? googleReauthenticationDeadline(freshGoogle.authenticatedAt, freshGoogle.expiresAt, now, intentExpiresAt)
        : null;
      const fresh = freshGoogle !== null && freshUntil !== null;
      const webSession = await issueWebSession(locked, {
        userId: user.id,
        authenticatedAt: fresh ? new Date(freshGoogle.authenticatedAt * 1000) : now,
        freshness: fresh ? 'login' : 'carried',
        presented: presentedSession,
        now,
        authority: receipt,
      });
      const issuedProof = await issueWebCredentialProof(
        locked,
        user.id,
        credentialProofVersion,
        webSession.generation,
        webSession.sessionId,
      );
      if (
        issuedProof &&
        (issuedProof.generation !== webSession.generation || issuedProof.authSessionId !== webSession.sessionId)
      )
        throw new Error('Web credential proof and web session disagree');
      const credentialProof = issuedProof && {
        ...issuedProof,
        authenticatedAt: fresh ? new Date(freshGoogle.authenticatedAt * 1000).toISOString() : null,
        linkGuarded: fresh,
      };
      return webOAuthResolveReplySchema.parse({
        webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
        operation: 'resolve',
        requestId,
        outcome: 'resolved',
        ...(credentialProof ? { credentialProof } : {}),
        webSession: {
          sessionId: webSession.sessionId,
          token: webSession.token,
          expiresAt: webSession.expiresAt.toISOString(),
          generation: webSession.generation,
        },
        createdUser,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          emailVerified: user.emailVerified?.toISOString() ?? null,
          createdAt: user.createdAt.toISOString(),
        },
        account: { provider, providerAccountId: subject },
      });
    }
    const execute = async (): Promise<WebOAuthResolveReply | Unavailable> => {
      await transactionSettings(transaction);
      await lockEnforcedProjection(transaction, authority);
      await revalidateIdentityAuthority(transaction, receipt);
      if (!ownedActorOnly && !(await claim(transaction, { requestId, issuedAt, operation: 'resolve' })))
        return denied('resolve', requestId, 'replayed');
      assertFresh(Date.parse(issuedAt));
      // The provider subject's lock before the actor's users row (section 4's
      // order: gate, subject, users). A native sign-in for the same subject takes
      // the subject first and then its owner's row, so taking the actor's row
      // first here could wait on it in a cycle. Re-entrant when resolved below.
      await lockProviderSubject(transaction, provider, subject);
      const primary = ownedActorOnly && captured.actor ? bindIdentityAuthority(transaction, receipt) : null;
      const observedOwner = primary ? await primary.findProvider(provider, subject) : null;
      const [intent] = await transaction
        .select()
        .from(authWebOAuthIntents)
        .where(eq(authWebOAuthIntents.intentHash, intentHash))
        .for('update');
      if (
        !before ||
        !intent ||
        !sameBinding(before, intent) ||
        intent.provider !== provider ||
        intent.flowHash !== flow ||
        intent.consumedAt ||
        !captured.valid ||
        !webOAuthActorStillValid(captured.actor) ||
        intent.actorUserId !== (captured.actor?.userId ?? null) ||
        intent.actorLineageHash !== (captured.actor?.lineageHash ?? null)
      )
        return denied('resolve', requestId);
      const actor = await actorGeneration(transaction, captured.actor);
      if (
        !actor.valid ||
        actor.generation !== intent.actorObservedGeneration ||
        !webOAuthActorStillValid(captured.actor)
      )
        return denied('resolve', requestId);
      if (ownedActorOnly && captured.actor) {
        // A normal signed-in OAuth callback may renew only an already-owned
        // selected identity. The explicit provider-security flow is the sole
        // link writer. Re-read after the actor lock and any primary-row wait
        // BEFORE consuming the legacy intent, even after a web preflight.
        const owner = await primary!.findProvider(provider, subject, 'update');
        if (
          !observedOwner ||
          !owner ||
          observedOwner.userId !== owner.userId ||
          observedOwner.generation !== owner.generation ||
          owner.userId !== captured.actor.userId ||
          owner.generation !== actor.generation ||
          actorCookie === null
        )
          return denied('resolve', requestId);
        const admitted = await readFirstPartySession(
          transaction,
          { kind: 'legacy-jwe', credential: actorCookie, secret: nextAuthSecret },
          new Date(await nowMilliseconds(transaction)),
          (userId) => readLockedWebSubjectState(transaction, userId),
        );
        if (admitted.status === 'unavailable') throw new Error('Web actor authority unavailable');
        if (
          admitted.status !== 'admitted' ||
          admitted.session.userId !== owner.userId ||
          admitted.session.generation !== owner.generation
        )
          return denied('resolve', requestId);
      }
      if (ownedActorOnly && !(await claim(transaction, { requestId, issuedAt, operation: 'resolve' })))
        return denied('resolve', requestId, 'replayed');
      const consumed = await transaction
        .update(authWebOAuthIntents)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(authWebOAuthIntents.intentHash, intentHash),
            isNull(authWebOAuthIntents.consumedAt),
            sql`${authWebOAuthIntents.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ intentHash: authWebOAuthIntents.intentHash });
      if (consumed.length !== 1) return denied('resolve', requestId);
      // Users rows in one pass, in id order, each at its final strength: the
      // provider's owner FOR UPDATE (identity resolution writes its rows) and
      // the presented account FOR UPDATE (its session is revoked). Crossed
      // sign-ins queue instead of deadlocking (#7596 B5a).
      intentExpiresAt = intent.expiresAt;
      if (sessionRequest) {
        presentedSession = await readPresentedWebSession(
          transaction,
          sessionRequest.presented,
          new Date(await nowMilliseconds(transaction)),
        );
        const owner = await bindIdentityAuthority(transaction, receipt).findProvider(provider, subject);
        // Decision D1 (#7596 B5e1): a browser signed in as a live session that
        // brings a provider identity no account owns is asking to connect it,
        // not to make a second account. Refuse with nothing created and the
        // presented session kept; the intent stays consumed, as on any end.
        if (!owner && presentedSession) return denied('resolve', requestId, 'link_required');
        await lockWebSessionAccounts(
          transaction,
          owner ? eq(users.id, owner.userId) : sql`false`,
          presentedSession?.userId,
          1,
          'update',
        );
      }
      // PostgreSQL must receive the exact provider subject/address, not a lossy
      // UTF-8 replacement of an unpaired JavaScript surrogate.
      if (
        !subject.trim() ||
        [subject, email, name, image].some(
          (text) => typeof text === 'string' && Buffer.from(text, 'utf8').toString('utf8') !== text,
        )
      )
        return denied('resolve', requestId);
      const identity = await resolveReservedCurrentStoreOAuthIdentity(
        transaction,
        authority,
        provider,
        { sub: subject, email, name, image, emailVerified: false },
        { storeProviderImage: true, emailVerification: 'unverified', actorUserId: captured.actor?.userId ?? null },
        undefined,
        receipt,
      );
      assertFresh(Date.parse(issuedAt));
      if (
        !webOAuthActorStillValid(captured.actor) ||
        (await nowMilliseconds(transaction)) >= intent.expiresAt.getTime()
      )
        throw new Error('Web OAuth intent expired before completion');
      if (identity.outcome === 'sensitive_link_unavailable') return { outcome: 'unavailable' } as const;
      if (identity.outcome === 'conflict') return denied('resolve', requestId, 'email_conflict');
      if (identity.outcome === 'no_email') return denied('resolve', requestId, 'email_required');
      if (identity.outcome !== 'linked' && identity.outcome !== 'created') return denied('resolve', requestId);
      const user = identity.user;
      if (sessionRequest) return signInWithWebSession(transaction, user, identity.outcome === 'created');
      let credentialProof = await issueWebCredentialProof(transaction, user.id, credentialProofVersion);
      if (credentialProof && actorCookie !== null) {
        const actorSession = await readFirstPartySession(
          transaction,
          { kind: 'legacy-jwe', credential: actorCookie, secret: nextAuthSecret },
          new Date(),
          (userId) => readLockedWebSubjectState(transaction, userId),
        );
        if (actorSession.status === 'unavailable') throw new Error('Web actor authority unavailable');
        if (actorSession.status !== 'admitted' || actorSession.session.userId !== user.id)
          return denied('resolve', requestId);
        // A provider callback in an existing session is a link/renewal, not a new
        // authentication of that session's owner. Keep unknown age unknown.
        credentialProof = {
          ...credentialProof,
          authSessionId: actorSession.session.authSessionId,
          generation: actorSession.session.generation,
          authenticatedAt: actorSession.session.authenticatedAt?.toISOString() ?? null,
          linkGuarded: actorSession.session.linkGuarded,
          ...(actorSession.session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
        };
      }
      return webOAuthResolveReplySchema.parse({
        webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
        operation: 'resolve',
        requestId,
        outcome: 'resolved',
        ...(credentialProof ? { credentialProof } : {}),
        createdUser: identity.outcome === 'created',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          emailVerified: user.emailVerified?.toISOString() ?? null,
          createdAt: user.createdAt.toISOString(),
        },
        account: { provider, providerAccountId: subject },
      });
    };
    const result = await execute();
    // Every committing result, including denials and nonce conflicts, passes
    // the final deadline fence after all row/uniqueness waits.
    assertFresh(Date.parse(issuedAt));
    if (!webOAuthActorStillValid(captured.actor)) throw new Error('Web OAuth actor expired before commit');
    await revalidateIdentityAuthority(transaction, receipt);
    return result;
  });
}
