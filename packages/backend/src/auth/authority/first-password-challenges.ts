import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, count, eq, gt, isNull } from 'drizzle-orm';
import { authFirstPasswordChallenges } from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
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
  FIRST_PASSWORD_CHALLENGES_PER_DAY,
  FIRST_PASSWORD_CHALLENGES_PER_HOUR,
  firstPasswordDeadline,
  type FirstPasswordRuntime,
} from './first-password-policy';
import {
  providerDatabaseNow,
  providerWebSessionHash,
  providerWebSessionIntentHash,
  PROVIDER_WEB_SESSION_BROWSER_VERSION,
  ProviderSecurityRefusal,
  type CapturedProviderActor,
} from './provider-security-context';
import type { FirstPartySession } from './session-reader';
import { RateLimitError } from '../../utils/rate-limiter';

export type FirstPasswordChallenge = typeof authFirstPasswordChallenges.$inferSelect;
export interface FirstPasswordBoundInput {
  readonly actor: ProviderSecurityActor;
  readonly challengeToken: string;
}
export interface CapturedFirstPasswordCommand {
  readonly actor: CapturedProviderActor;
  readonly challengeToken: string;
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
  const { challengeToken } = input;
  return Object.freeze({ actor: captureFirstPasswordActor(input.actor, runtime), challengeToken });
}

/**
 * The stored actor and the session read now are one session at one
 * generation. The expiry is not compared: a roll moves it, and the reader has
 * already refused an expired session.
 */
function sameOriginalSession(challenge: FirstPasswordChallenge, session: FirstPartySession): boolean {
  return (
    challenge.userId === session.userId &&
    challenge.actorSessionId === session.authSessionId &&
    challenge.actorGeneration === session.generation &&
    challenge.actorAuthenticatedAt?.getTime() === session.authenticatedAt?.getTime() &&
    challenge.actorLinkGuarded === session.linkGuarded &&
    challenge.actorRequiresAccountCutoff === session.requiresAccountCutoff
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
  const [challenge] = await transaction
    .select()
    .from(authFirstPasswordChallenges)
    .where(eq(authFirstPasswordChallenges.challengeHash, firstPasswordTokenHash('challenge', command.challengeToken)))
    .for('update');
  if (!challenge) throw new FirstPasswordRefusal('denied', 'invalid_proof');
  if (
    challenge.purpose !== 'first-password' ||
    challenge.actorCredentialKind !== command.actor.input.presented.kind ||
    // The same session token that asked for the email must complete it.
    !equalFirstPasswordDigest(challenge.actorCredentialHash, command.actor.credentialHash) ||
    challenge.browserBindingHash !== providerWebSessionHash(eligible.session.authSessionId) ||
    challenge.browserVersion !== PROVIDER_WEB_SESSION_BROWSER_VERSION ||
    challenge.browserIntentHash !== providerWebSessionIntentHash(challenge.challengeHash) ||
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
  const now = await providerDatabaseNow(transaction);
  const deadline = Math.min(challenge.expiresAt.getTime(), eligible.session.expiresAt.getTime());
  if (!Number.isSafeInteger(deadline) || challenge.issuedAt.getTime() > now.getTime() || deadline <= now.getTime())
    throw new FirstPasswordRefusal('denied', 'expired');
  return { ...eligible, challenge, now };
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
  const challengeToken = randomBytes(32).toString('base64url');
  const confirmationToken = randomBytes(32).toString('base64url');
  const recoveryToken = randomBytes(32).toString('base64url');
  const operationId = randomUUID();
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const eligible = await lockFirstPasswordEligibility(transaction, authority, runtime, actor);
    const now = await providerDatabaseNow(transaction);
    // The durable mail cap, counted under the `users` lock eligibility took: refused the
    // way the per-minute limit is (503), before anything is written or planned.
    const issuedSince = async (since: Date) =>
      (
        await transaction
          .select({ total: count() })
          .from(authFirstPasswordChallenges)
          .where(
            and(
              eq(authFirstPasswordChallenges.userId, eligible.session.userId),
              gt(authFirstPasswordChallenges.issuedAt, since),
            ),
          )
      )[0]?.total ?? 0;
    if (
      (await issuedSince(new Date(now.getTime() - 60 * 60_000))) >= FIRST_PASSWORD_CHALLENGES_PER_HOUR ||
      (await issuedSince(new Date(now.getTime() - 24 * 60 * 60_000))) >= FIRST_PASSWORD_CHALLENGES_PER_DAY
    )
      throw new RateLimitError(60 * 60);
    const expiresAt = firstPasswordDeadline(now, eligible.session.expiresAt);
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
    const challengeHash = firstPasswordTokenHash('challenge', challengeToken);
    await transaction.insert(authFirstPasswordChallenges).values({
      challengeHash,
      purpose: 'first-password',
      operationId,
      userId: eligible.session.userId,
      emailBindingHash: eligible.emailBindingHash,
      confirmationTokenHash: firstPasswordTokenHash('confirmation', confirmationToken),
      recoveryTokenHash: firstPasswordTokenHash('recovery', recoveryToken),
      actorCredentialKind: actor.input.presented.kind,
      actorCredentialHash: actor.credentialHash,
      actorSessionId: eligible.session.authSessionId,
      actorGeneration: eligible.session.generation,
      actorAuthenticatedAt: eligible.session.authenticatedAt,
      actorLinkGuarded: eligible.session.linkGuarded,
      actorRequiresAccountCutoff: eligible.session.requiresAccountCutoff,
      actorExpiresAt: eligible.session.expiresAt,
      // The NOT NULL binding columns, keyed by the web session (no migration).
      browserBindingHash: providerWebSessionHash(eligible.session.authSessionId),
      browserVersion: PROVIDER_WEB_SESSION_BROWSER_VERSION,
      browserIntentHash: providerWebSessionIntentHash(challengeHash),
      browserBindingExpiresAt: eligible.session.expiresAt,
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
    return { outcome: context.challenge.phase as 'pending' | 'prepared', expiresAt: context.challenge.expiresAt };
  });
}
