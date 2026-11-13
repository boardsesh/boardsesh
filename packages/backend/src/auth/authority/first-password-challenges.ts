import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authBrowserBindings, authBrowserIntents, authFirstPasswordChallenges } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import { beginBrowserIntent, type BrowserBindingCursor } from './browser-binding';
import type { IdentityAuthorityReceipt } from './router';
import {
  captureFirstPasswordActor,
  FirstPasswordRefusal,
  lockFirstPasswordEligibility,
  withFirstPasswordAuthority,
} from './first-password-context';
import {
  captureFirstPasswordRuntime,
  equalFirstPasswordDigest,
  firstPasswordDeadline,
  type FirstPasswordRuntime,
} from './first-password-policy';
import {
  providerDatabaseNow,
  providerTokenHash,
  ProviderSecurityRefusal,
  type CapturedProviderActor,
} from './provider-security-context';
import type { FirstPartySession } from './session-reader';

export type FirstPasswordChallenge = typeof authFirstPasswordChallenges.$inferSelect;
export interface FirstPasswordBoundInput {
  readonly actor: ProviderSecurityActor;
  readonly challengeToken: string;
  readonly browserIntentToken: string;
}
export interface CapturedFirstPasswordCommand {
  readonly actor: CapturedProviderActor;
  readonly challengeToken: string;
  readonly browserIntentToken: string;
}

export function firstPasswordTokenHash(
  role: 'challenge' | 'confirmation' | 'recovery' | 'preparation',
  token: string,
): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new FirstPasswordRefusal('denied', 'invalid_proof');
  return createHash('sha256')
    .update(JSON.stringify(['boardsesh.first-password.token.v1', role, token]))
    .digest('hex');
}

export function captureFirstPasswordCommand(
  input: FirstPasswordBoundInput,
  runtime: FirstPasswordRuntime,
): CapturedFirstPasswordCommand {
  const { challengeToken, browserIntentToken } = input;
  return Object.freeze({ actor: captureFirstPasswordActor(input.actor, runtime), challengeToken, browserIntentToken });
}

async function replacementIntent(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  cursor: BrowserBindingCursor,
  intentToken: string,
) {
  const [observed] = await transaction
    .select({ intent: authBrowserIntents, revision: authBrowserBindings.intentRevision })
    .from(authBrowserIntents)
    .innerJoin(authBrowserBindings, eq(authBrowserIntents.bindingId, authBrowserBindings.id))
    .where(and(eq(authBrowserIntents.id, providerTokenHash(intentToken)), eq(authBrowserBindings.id, cursor.bindingId)))
    .for('update', { of: authBrowserIntents });
  const now = await providerDatabaseNow(transaction);
  if (
    !observed ||
    observed.intent.operation !== 'replacement' ||
    observed.intent.formatVersion !== 2 ||
    observed.intent.expectedVersion !== cursor.version ||
    observed.intent.revision !== observed.revision ||
    observed.intent.consumedAt !== null ||
    observed.intent.expiresAt.getTime() <= now.getTime()
  )
    throw new FirstPasswordRefusal('denied', 'invalid_proof');
  if (
    observed.intent.projectionId !== authority.projectionId ||
    observed.intent.authority !== authority.authority ||
    observed.intent.epoch !== authority.epoch
  )
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  return { intent: observed.intent, now };
}

function sameOriginalSession(challenge: FirstPasswordChallenge, session: FirstPartySession): boolean {
  return (
    challenge.userId === session.userId &&
    challenge.actorSessionId === session.authSessionId &&
    challenge.actorGeneration === session.generation &&
    challenge.actorAuthenticatedAt?.getTime() === session.authenticatedAt?.getTime() &&
    challenge.actorLinkGuarded === session.linkGuarded &&
    challenge.actorRequiresAccountCutoff === session.requiresAccountCutoff &&
    challenge.actorExpiresAt.getTime() === session.expiresAt.getTime()
  );
}

/** Read-only admission: the command never chooses a user by an email address. */
export async function loadFirstPasswordChallenge(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  runtime: FirstPasswordRuntime,
  command: CapturedFirstPasswordCommand,
  phases: readonly FirstPasswordChallenge['phase'][] = ['pending', 'prepared'],
) {
  const eligible = await lockFirstPasswordEligibility(transaction, authority, runtime, command.actor);
  const { intent, now } = await replacementIntent(transaction, authority, eligible.cursor, command.browserIntentToken);
  const [challenge] = await transaction
    .select()
    .from(authFirstPasswordChallenges)
    .where(eq(authFirstPasswordChallenges.challengeHash, firstPasswordTokenHash('challenge', command.challengeToken)))
    .for('update');
  if (!challenge) throw new FirstPasswordRefusal('denied', 'invalid_proof');
  if (
    challenge.purpose !== 'first-password' ||
    challenge.actorCredentialKind !== command.actor.input.kind ||
    !equalFirstPasswordDigest(challenge.actorCredentialHash, command.actor.credentialHash) ||
    challenge.browserBindingHash !== eligible.cursor.bindingId ||
    challenge.browserVersion !== eligible.cursor.version ||
    challenge.browserIntentHash !== providerTokenHash(command.browserIntentToken) ||
    challenge.browserBindingExpiresAt.getTime() !== eligible.cursor.bindingExpiresAt.getTime() ||
    !sameOriginalSession(challenge, eligible.session)
  )
    throw new FirstPasswordRefusal('identity_changed', 'invalid_proof');
  if (
    challenge.projectionId !== authority.projectionId ||
    challenge.normalizerVersion !== authority.normalizerVersion ||
    challenge.writerAuthority !== authority.authority ||
    challenge.writerEpoch !== authority.epoch
  )
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  if (!equalFirstPasswordDigest(challenge.emailBindingHash, eligible.emailBindingHash))
    throw new FirstPasswordRefusal('identity_changed', 'email_changed');
  if (!phases.includes(challenge.phase) || challenge.consumedAt !== null)
    throw new FirstPasswordRefusal('denied', 'replayed');
  const deadline = Math.min(
    challenge.expiresAt.getTime(),
    eligible.session.expiresAt.getTime(),
    eligible.cursor.bindingExpiresAt.getTime(),
    intent.expiresAt.getTime(),
  );
  if (!Number.isSafeInteger(deadline) || challenge.issuedAt.getTime() > now.getTime() || deadline <= now.getTime())
    throw new FirstPasswordRefusal('denied', 'expired');
  return { ...eligible, challenge, browserIntent: intent, now };
}

/** Private mail plan only. A public adapter must never expose its confirmation
 * token. This command imports no delivery transport and sends no email. */
export async function requestFirstPasswordChallenge(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: { readonly actor: ProviderSecurityActor },
) {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const actor = captureFirstPasswordActor(input.actor, runtime);
  // Refuse ineligible requests before even changing a browser intent nonce.
  await withFirstPasswordAuthority(database, runtime, (transaction, authority) =>
    lockFirstPasswordEligibility(transaction, authority, runtime, actor),
  );
  const browser = await beginBrowserIntent(database, runtime.qualification, actor.input.browserBindingToken, {
    operation: 'replacement',
    expectedVersion: actor.input.browserVersion,
    expectedIdentity: { userId: actor.input.expectedUserId, authSessionId: actor.input.expectedAuthSessionId },
    presented: { version: actor.input.browserVersion, credential: actor.credential },
  });
  if (browser.status === 'unavailable') throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  if (browser.status !== 'prepared') throw new FirstPasswordRefusal('identity_changed', 'invalid_proof');
  const challengeToken = randomBytes(32).toString('base64url');
  const confirmationToken = randomBytes(32).toString('base64url');
  const recoveryToken = randomBytes(32).toString('base64url');
  const operationId = randomUUID();
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const eligible = await lockFirstPasswordEligibility(transaction, authority, runtime, actor);
    const { intent, now } = await replacementIntent(transaction, authority, eligible.cursor, browser.intentToken);
    const expiresAt = firstPasswordDeadline(
      now,
      eligible.session.expiresAt,
      eligible.cursor.bindingExpiresAt,
      intent.expiresAt,
    );
    await transaction
      .update(authFirstPasswordChallenges)
      .set({
        phase: 'terminal',
        pendingPasswordHash: null,
        preparedAt: null,
        preparationTokenHash: null,
        proposedCredentialHash: null,
        consumedAt: now,
        candidateCredentialHash: null,
        recoveryExpiresAt: null,
      })
      .where(
        and(
          eq(authFirstPasswordChallenges.userId, eligible.session.userId),
          isNull(authFirstPasswordChallenges.consumedAt),
        ),
      );
    await transaction.insert(authFirstPasswordChallenges).values({
      challengeHash: firstPasswordTokenHash('challenge', challengeToken),
      purpose: 'first-password',
      operationId,
      userId: eligible.session.userId,
      emailBindingHash: eligible.emailBindingHash,
      confirmationTokenHash: firstPasswordTokenHash('confirmation', confirmationToken),
      recoveryTokenHash: firstPasswordTokenHash('recovery', recoveryToken),
      actorCredentialKind: actor.input.kind,
      actorCredentialHash: actor.credentialHash,
      actorSessionId: eligible.session.authSessionId,
      actorGeneration: eligible.session.generation,
      actorAuthenticatedAt: eligible.session.authenticatedAt,
      actorLinkGuarded: eligible.session.linkGuarded,
      actorRequiresAccountCutoff: eligible.session.requiresAccountCutoff,
      actorExpiresAt: eligible.session.expiresAt,
      browserBindingHash: eligible.cursor.bindingId,
      browserVersion: eligible.cursor.version,
      browserIntentHash: intent.id,
      browserBindingExpiresAt: eligible.cursor.bindingExpiresAt,
      projectionId: authority.projectionId,
      normalizerVersion: authority.normalizerVersion,
      writerAuthority: authority.authority,
      writerEpoch: authority.epoch,
      issuedAt: now,
      expiresAt,
    });
    if ((await providerDatabaseNow(transaction)).getTime() >= expiresAt.getTime())
      throw new FirstPasswordRefusal('denied', 'expired');
    return {
      outcome: 'issued' as const,
      challengeToken,
      recoveryToken,
      browserIntentToken: browser.intentToken,
      browserCursor: eligible.cursor,
      expiresAt,
      mailPlan: {
        kind: 'uid-first-password-v1' as const,
        recipient: eligible.recipient,
        token: confirmationToken,
        expiresAt,
      },
    };
  });
}

/** GET/probe semantics: actual possession is checked, no nonce is consumed,
 * no password is set, and no confirmation token/hash is returned. */
export async function readFirstPasswordChallenge(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: FirstPasswordBoundInput,
) {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const command = captureFirstPasswordCommand(input, runtime);
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const context = await loadFirstPasswordChallenge(transaction, authority, runtime, command);
    return {
      outcome: context.challenge.phase as 'pending' | 'prepared',
      expiresAt: context.challenge.expiresAt,
      browserCursor: context.cursor,
    };
  });
}
