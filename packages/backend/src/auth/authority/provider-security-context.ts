import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { authBrowserBindings, authBrowserIntents, authProviderSecurityIntents } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import type { AuthorityTransaction } from './adapter';
import { readBrowserBindingInTransaction, type BrowserBindingCursor } from './browser-binding';
import type { FirstPartyCredential, FirstPartySession } from './session-reader';
import { providerCredentialHash, presentedProviderCredential } from './provider-security-result';
import type { ProviderReauthenticationBinding } from './provider-reauthentication-evidence';
import { revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';

export type ProviderSecurityIntent = typeof authProviderSecurityIntents.$inferSelect;
export type ProviderSecurityFailureOutcome =
  | 'unauthenticated'
  | 'identity_changed'
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
  | 'authority_unavailable';

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
  readonly credentialHash: string;
}
export interface ProviderBoundCommand {
  readonly actor: CapturedProviderActor;
  readonly intentToken: string;
  readonly browserIntentToken: string;
}
export const providerTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Capture every request and issuer primitive before authority reads or crypto awaits. */
export function captureProviderActor(
  actor: ProviderSecurityActor,
  legacySecret: string | undefined,
): CapturedProviderActor {
  const input = Object.freeze({ ...actor });
  if (input.kind === 'legacy-jwe' && !legacySecret)
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  const credential: FirstPartyCredential =
    input.kind === 'legacy-jwe'
      ? Object.freeze({ kind: 'legacy-jwe', credential: input.credential, secret: legacySecret! })
      : Object.freeze({ kind: 'canonical-token', token: input.credential });
  return Object.freeze({
    input,
    credential,
    credentialHash: providerCredentialHash(presentedProviderCredential(credential)),
  });
}
export function captureProviderBoundCommand(
  input: { readonly actor: ProviderSecurityActor; readonly intentToken: string; readonly browserIntentToken: string },
  legacySecret: string | undefined,
): ProviderBoundCommand {
  const { intentToken, browserIntentToken } = input;
  return Object.freeze({ actor: captureProviderActor(input.actor, legacySecret), intentToken, browserIntentToken });
}
export async function providerDatabaseNow(transaction: AuthorityTransaction): Promise<Date> {
  const row = await executeFirstRow<{ now: string | Date }>(transaction, sql`SELECT clock_timestamp() AS now`);
  const now = row ? new Date(row.now) : null;
  if (!now || !Number.isFinite(now.getTime()))
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  return now;
}

export async function admitProviderActorInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  actor: CapturedProviderActor,
): Promise<{ readonly session: FirstPartySession; readonly cursor: BrowserBindingCursor }> {
  const admitted = await readBrowserBindingInTransaction(transaction, authority, {
    bindingToken: actor.input.browserBindingToken,
    actor: { version: actor.input.browserVersion, credential: actor.credential },
  });
  if (admitted.status === 'unavailable') throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  if (admitted.status !== 'admitted') throw new ProviderSecurityRefusal('unauthenticated', 'invalid_proof');
  if (
    admitted.session.userId !== actor.input.expectedUserId ||
    admitted.session.authSessionId !== actor.input.expectedAuthSessionId ||
    admitted.cursor.version !== actor.input.browserVersion
  )
    throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  return { session: admitted.session, cursor: admitted.cursor };
}

function sameSession(intent: ProviderSecurityIntent, session: FirstPartySession): boolean {
  return (
    intent.userId === session.userId &&
    intent.actorSessionId === session.authSessionId &&
    intent.actorGeneration === session.generation &&
    intent.actorAuthenticatedAt?.getTime() === session.authenticatedAt?.getTime() &&
    intent.actorLinkGuarded === session.linkGuarded &&
    intent.actorRequiresAccountCutoff === session.requiresAccountCutoff &&
    intent.actorExpiresAt.getTime() === session.expiresAt.getTime()
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
  readonly cursor: BrowserBindingCursor;
  readonly now: Date;
}> {
  await revalidateIdentityAuthority(transaction, authority);
  const admitted = await admitProviderActorInTransaction(transaction, authority, command.actor);
  const [intent] = await transaction
    .select()
    .from(authProviderSecurityIntents)
    .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(command.intentToken)))
    .for('update');
  if (!intent) throw new ProviderSecurityRefusal('denied', 'invalid_intent');
  if (
    intent.actorCredentialKind !== command.actor.input.kind ||
    intent.actorCredentialHash !== command.actor.credentialHash ||
    intent.browserBindingHash !== providerTokenHash(command.actor.input.browserBindingToken) ||
    intent.browserVersion !== admitted.cursor.version ||
    intent.browserIntentHash !== providerTokenHash(command.browserIntentToken) ||
    intent.browserBindingExpiresAt.getTime() !== admitted.cursor.bindingExpiresAt.getTime() ||
    !sameSession(intent, admitted.session)
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
  const [browserIntent] = await transaction
    .select({ intent: authBrowserIntents, revision: authBrowserBindings.intentRevision })
    .from(authBrowserIntents)
    .innerJoin(authBrowserBindings, eq(authBrowserBindings.id, authBrowserIntents.bindingId))
    .where(
      and(eq(authBrowserIntents.id, intent.browserIntentHash), eq(authBrowserBindings.id, intent.browserBindingHash)),
    );
  if (
    !browserIntent ||
    browserIntent.intent.formatVersion !== 2 ||
    browserIntent.intent.operation !== 'replacement' ||
    browserIntent.intent.revision !== browserIntent.revision ||
    browserIntent.intent.expectedVersion !== intent.browserVersion ||
    browserIntent.intent.consumedAt !== null ||
    browserIntent.intent.expiresAt.getTime() <= now.getTime() ||
    browserIntent.intent.projectionId !== authority.projectionId ||
    browserIntent.intent.authority !== authority.authority ||
    browserIntent.intent.epoch !== authority.epoch
  )
    throw new ProviderSecurityRefusal('denied', 'invalid_intent');
  return { intent, session: admitted.session, cursor: admitted.cursor, now };
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
