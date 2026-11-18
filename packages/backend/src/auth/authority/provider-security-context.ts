import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { authProviderSecurityIntents } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import type { AuthorityTransaction } from './adapter';
import { readFirstPartySession, type FirstPartyCredential, type FirstPartySession } from './session-reader';
import { providerCredentialHash, presentedProviderCredential } from './provider-security-result';
import type { ProviderReauthenticationBinding } from './provider-reauthentication-evidence';
import { revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';
import { lockSubjectRow } from '../current-store/foundation-context';
import { readLockedWebSubjectState } from '../current-store/web-credential-state';

export type ProviderSecurityIntent = typeof authProviderSecurityIntents.$inferSelect;
export type ProviderSecurityFailureOutcome =
  | 'unauthenticated'
  | 'identity_changed'
  | 'canonical_session_required'
  | 'reauthentication_required'
  | 'reauthentication_unavailable'
  | 'denied'
  | 'unavailable';
export type ProviderSecurityFailureCode =
  | 'invalid_intent'
  | 'invalid_proof'
  | 'expired'
  | 'replayed'
  | 'provider_unavailable'
  | 'provider_not_verified'
  | 'ownership_conflict'
  | 'last_usable_method'
  | 'authority_unavailable'
  | 'canonical_session_required'
  | 'too_many_pending';

export class ProviderSecurityRefusal extends Error {
  constructor(
    readonly outcome: ProviderSecurityFailureOutcome,
    readonly code: ProviderSecurityFailureCode,
  ) {
    super('Provider security command refused');
    this.name = 'ProviderSecurityRefusal';
  }
}
export interface CapturedProviderActor {
  readonly input: ProviderSecurityActor;
  readonly credential: FirstPartyCredential;
  /** The presented token's hash. A link or unlink keeps the token, so it is the same at every step. */
  readonly credentialHash: string;
}
export interface ProviderBoundCommand {
  readonly actor: CapturedProviderActor;
  readonly intentToken: string;
}
export const providerTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * What an intent stores in its NOT NULL `browser_binding_hash` column now that
 * the actor is a web session, not a browser binding (#7596 B5c1, no
 * migration): the session id under a fixed prefix. A binding hash was the
 * SHA-256 of a bare 43-character token, so the two can never be equal.
 */
export function providerWebSessionHash(sessionId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['provider-security-web-session-v1', sessionId]))
    .digest('hex');
}
/**
 * What an intent stores in its NOT NULL `browser_intent_hash` column. No
 * browser intent exists any more: the provider intent's own phase is the one
 * single-use record, so the column holds a value derived from it.
 */
export function providerWebSessionIntentHash(intentHash: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['provider-security-no-browser-intent-v1', intentHash]))
    .digest('hex');
}
/**
 * A link, unlink or first password moves the account's generation and keeps
 * the requesting session's token. A legacy NextAuth cookie carries its
 * generation inside the cookie, so it could continue only by being re-issued,
 * which only a login may do (#7596). www bridges it to a canonical session
 * first; this refusal tells it to, apart from a missing reauthentication.
 */
export function requireCanonicalProviderActor(actor: CapturedProviderActor): { readonly token: string } {
  if (actor.credential.kind !== 'canonical-token')
    throw new ProviderSecurityRefusal('canonical_session_required', 'canonical_session_required');
  return { token: actor.credential.token };
}
/** A web session has no browser version; the NOT NULL column holds this. */
export const PROVIDER_WEB_SESSION_BROWSER_VERSION = 0;

/** Capture every request and issuer primitive before authority reads or crypto awaits. */
export function captureProviderActor(
  actor: ProviderSecurityActor,
  legacySecret: string | undefined,
): CapturedProviderActor {
  const presented = Object.freeze({ ...actor.presented });
  const input: ProviderSecurityActor = Object.freeze({
    presented,
    expectedUserId: actor.expectedUserId,
    expectedAuthSessionId: actor.expectedAuthSessionId,
  });
  if (presented.kind === 'legacy-jwe' && !legacySecret)
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  const credential: FirstPartyCredential =
    presented.kind === 'legacy-jwe'
      ? Object.freeze({ kind: 'legacy-jwe', credential: presented.credential, secret: legacySecret! })
      : Object.freeze({ kind: 'canonical-token', token: presented.token });
  return Object.freeze({
    input,
    credential,
    credentialHash: providerCredentialHash(presentedProviderCredential(credential)),
  });
}
export function captureProviderBoundCommand(
  input: { readonly actor: ProviderSecurityActor; readonly intentToken: string },
  legacySecret: string | undefined,
): ProviderBoundCommand {
  const { intentToken } = input;
  return Object.freeze({ actor: captureProviderActor(input.actor, legacySecret), intentToken });
}
export async function providerDatabaseNow(transaction: AuthorityTransaction): Promise<Date> {
  const row = await executeFirstRow<{ now: string | Date }>(transaction, sql`SELECT clock_timestamp() AS now`);
  const now = row ? new Date(row.now) : null;
  if (!now || !Number.isFinite(now.getTime()))
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  return now;
}

/**
 * Admit the presented web session by exactly the rules every request uses
 * (`readFirstPartySession`): live, not denied, at the account's generation.
 * The account's `users` row is locked FOR UPDATE between a first read, which
 * names the account, and a second read under the lock, so the generation and
 * denials it checks cannot move before this transaction ends.
 */
export async function admitProviderActorInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  actor: CapturedProviderActor,
): Promise<{ readonly session: FirstPartySession }> {
  await revalidateIdentityAuthority(transaction, authority);
  // A fresh database clock for each read: the second may have waited on the lock.
  const readSession = async () =>
    readFirstPartySession(transaction, actor.credential, await providerDatabaseNow(transaction), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    );
  const requireExpected = (outcome: Awaited<ReturnType<typeof readSession>>): FirstPartySession => {
    if (outcome.status === 'unavailable') throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
    if (outcome.status !== 'admitted') throw new ProviderSecurityRefusal('unauthenticated', 'invalid_proof');
    if (
      outcome.session.userId !== actor.input.expectedUserId ||
      outcome.session.authSessionId !== actor.input.expectedAuthSessionId
    )
      throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
    return outcome.session;
  };
  const observed = requireExpected(await readSession());
  await lockSubjectRow(transaction, observed.userId);
  const session = requireExpected(await readSession());
  if (session.generation !== observed.generation)
    throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  await revalidateIdentityAuthority(transaction, authority);
  return { session };
}

/**
 * The stored actor and the session read now are one session at one
 * generation. The expiry is not compared: a roll moves it, and the reader has
 * already refused an expired session.
 */
function sameSession(intent: ProviderSecurityIntent, session: FirstPartySession): boolean {
  return (
    intent.userId === session.userId &&
    intent.actorSessionId === session.authSessionId &&
    intent.actorGeneration === session.generation &&
    intent.actorAuthenticatedAt?.getTime() === session.authenticatedAt?.getTime() &&
    intent.actorLinkGuarded === session.linkGuarded &&
    intent.actorRequiresAccountCutoff === session.requiresAccountCutoff
  );
}

/**
 * Call after the gate and any provider subject locks. Actor admission takes the
 * users/cutoff/binding locks before this intent row. Refused or stale actors do
 * not consume an intent or a reauthentication receipt.
 */
export async function loadProviderIntentInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  command: ProviderBoundCommand,
  phases: readonly ProviderSecurityIntent['phase'][] = ['pending', 'prepared'],
): Promise<{
  readonly intent: ProviderSecurityIntent;
  readonly session: FirstPartySession;
  readonly now: Date;
}> {
  await revalidateIdentityAuthority(transaction, authority);
  const { session } = await admitProviderActorInTransaction(transaction, authority, command.actor);
  const [intent] = await transaction
    .select()
    .from(authProviderSecurityIntents)
    .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(command.intentToken)))
    .for('update');
  if (!intent) throw new ProviderSecurityRefusal('denied', 'invalid_intent');
  if (
    intent.actorCredentialKind !== command.actor.input.presented.kind ||
    intent.actorCredentialHash !== command.actor.credentialHash ||
    intent.browserBindingHash !== providerWebSessionHash(session.authSessionId) ||
    intent.browserVersion !== PROVIDER_WEB_SESSION_BROWSER_VERSION ||
    intent.browserIntentHash !== providerWebSessionIntentHash(intent.intentHash) ||
    !sameSession(intent, session)
  )
    throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  if (
    intent.projectionId !== authority.projectionId ||
    intent.normalizerVersion !== authority.normalizerVersion ||
    intent.writerAuthority !== authority.authority ||
    intent.writerEpoch !== authority.epoch
  )
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  const now = await providerDatabaseNow(transaction);
  if (intent.expiresAt.getTime() <= now.getTime() || intent.actorExpiresAt.getTime() <= now.getTime())
    throw new ProviderSecurityRefusal('denied', 'expired');
  if (!phases.includes(intent.phase)) throw new ProviderSecurityRefusal('denied', 'replayed');
  return { intent, session, now };
}

export function providerReauthenticationBinding(intent: ProviderSecurityIntent): ProviderReauthenticationBinding {
  return Object.freeze({
    intentHash: intent.intentHash,
    actorCredentialHash: intent.actorCredentialHash,
    userId: intent.userId,
    actorSessionId: intent.actorSessionId,
    actorGeneration: intent.actorGeneration,
    operation: intent.operation,
    provider: intent.provider,
    unlinkSubject: intent.operation === 'unlink' ? intent.providerSubject : null,
    authority: Object.freeze({
      projectionId: intent.projectionId,
      normalizerVersion: intent.normalizerVersion,
      authority: intent.writerAuthority,
      epoch: intent.writerEpoch,
    }),
    expiresAt: new Date(intent.expiresAt),
  });
}
