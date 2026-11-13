import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hash } from 'bcryptjs';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import { setPasswordCommandSchema, type WebCredentialProof } from '@boardsesh/auth-protocol';
import { authFirstPasswordChallenges } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import {
  prepareBrowserReplacementInTransaction,
  commitPreparedBrowserReplacementInTransaction,
  readBrowserBindingInTransaction,
} from './browser-binding';
import {
  captureFirstPasswordCommand,
  firstPasswordTokenHash,
  loadFirstPasswordChallenge,
  type FirstPasswordBoundInput,
  type FirstPasswordChallenge,
} from './first-password-challenges';
import { FirstPasswordRefusal, withFirstPasswordAuthority } from './first-password-context';
import {
  captureFirstPasswordRuntime,
  equalFirstPasswordDigest,
  FIRST_PASSWORD_RECOVERY_LIFETIME_MS,
  type FirstPasswordRuntime,
} from './first-password-policy';
import { providerDatabaseNow, providerTokenHash, ProviderSecurityRefusal } from './provider-security-context';
import {
  providerCandidateCredentialSchema,
  providerCredentialHash,
  type ProviderCandidateCredential,
} from './provider-security-result';
import { recordIdentityPasswordMutation } from './password-mutation';
import { replaceProviderCanonicalContinuation } from './provider-security-continuation';
import { revalidateIdentityAuthority } from './router';

type Context = Awaited<ReturnType<typeof loadFirstPasswordChallenge>>;
function contextDeadline(context: Context): number {
  return Math.min(
    context.challenge.expiresAt.getTime(),
    context.session.expiresAt.getTime(),
    context.cursor.bindingExpiresAt.getTime(),
    context.browserIntent.expiresAt.getTime(),
  );
}
async function requireLastClock(transaction: AuthorityTransaction, expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || (await providerDatabaseNow(transaction)).getTime() >= expiresAt)
    throw new FirstPasswordRefusal('denied', 'expired');
}
function credentialProof(context: Context): WebCredentialProof {
  return {
    version: 1,
    userId: context.session.userId,
    authSessionId: context.session.authSessionId,
    generation: context.session.generation + 1,
    authenticatedAt: context.session.authenticatedAt?.toISOString() ?? null,
    linkGuarded: context.session.linkGuarded,
    ...(context.session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
  };
}
function presentedCandidate(candidate: ProviderCandidateCredential, runtime: FirstPasswordRuntime) {
  if (candidate.kind === 'canonical-token') return { kind: candidate.kind, token: candidate.credential };
  if (!runtime.legacySecret) throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  return { kind: candidate.kind, credential: candidate.credential, secret: runtime.legacySecret };
}

/** Email ownership permits only preparing a first password. It creates no
 * provider reauthentication receipt and never changes original session age. */
export async function prepareFirstPasswordChallenge(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: FirstPasswordBoundInput & {
    readonly confirmationToken: string;
    readonly password: string;
    readonly confirmPassword: string;
  },
) {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const command = captureFirstPasswordCommand(input, runtime);
  const { password, confirmPassword, confirmationToken } = input;
  const validPassword = setPasswordCommandSchema.shape.payload.shape.password.safeParse(password);
  if (!validPassword.success || password !== confirmPassword) throw new FirstPasswordRefusal('denied', 'invalid_proof');
  const confirmationHash = firstPasswordTokenHash('confirmation', confirmationToken);
  // No expensive hash or token issuance before actual actor/mail ownership.
  const originalAuthority = await withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const context = await loadFirstPasswordChallenge(transaction, authority, runtime, command);
    if (!equalFirstPasswordDigest(context.challenge.confirmationTokenHash, confirmationHash))
      throw new FirstPasswordRefusal('denied', 'invalid_proof');
    return authority;
  });
  const passwordHash = await hash(password, PASSWORD_HASH_COST);
  const preparationToken = randomBytes(32).toString('base64url');
  const proposedCanonicalToken =
    command.actor.input.kind === 'canonical-token' ? randomBytes(32).toString('base64url') : null;
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    await revalidateIdentityAuthority(transaction, originalAuthority);
    const context = await loadFirstPasswordChallenge(transaction, authority, runtime, command);
    if (!equalFirstPasswordDigest(context.challenge.confirmationTokenHash, confirmationHash))
      throw new FirstPasswordRefusal('denied', 'invalid_proof');
    const expiresAt = new Date(contextDeadline(context));
    const [prepared] = await transaction
      .update(authFirstPasswordChallenges)
      .set({
        phase: 'prepared',
        pendingPasswordHash: passwordHash,
        preparedAt: context.now,
        preparationTokenHash: firstPasswordTokenHash('preparation', preparationToken),
        proposedCredentialHash: proposedCanonicalToken
          ? providerCredentialHash({ kind: 'canonical-token', credential: proposedCanonicalToken })
          : null,
        // Preparation may shorten the original bound; it can never extend it.
        expiresAt,
      })
      .where(
        and(
          eq(authFirstPasswordChallenges.challengeHash, context.challenge.challengeHash),
          isNull(authFirstPasswordChallenges.consumedAt),
        ),
      )
      .returning({ hash: authFirstPasswordChallenges.challengeHash });
    if (!prepared) throw new FirstPasswordRefusal('denied', 'replayed');
    await revalidateIdentityAuthority(transaction, authority);
    await requireLastClock(transaction, expiresAt.getTime());
    return {
      outcome: 'prepared' as const,
      preparationToken,
      credentialProof: credentialProof(context),
      credentialExpiresAt: context.session.expiresAt,
      expiresAt,
      browserCursor: context.cursor,
      proposedCanonicalToken,
      user: {
        id: context.user.id,
        email: context.user.email,
        name: context.user.name,
        image: context.user.image,
        // The response is buffered before commit. Predict the exact clock that
        // finalize will atomically stamp for this already-confirmed address.
        emailVerified: context.user.emailVerified ?? context.now,
        createdAt: context.user.createdAt,
      },
    };
  });
}

/** Invoke only after the exact continuation cookie and complete response are
 * buffered. Every password/mirror/cutoff/revocation/selection/challenge write
 * below uses this one physical transaction and rolls back on any late refusal. */
export async function finalizeFirstPasswordChallenge(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: FirstPasswordBoundInput & {
    readonly preparationToken: string;
    readonly candidate: ProviderCandidateCredential;
  },
) {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const command = captureFirstPasswordCommand(input, runtime);
  const { preparationToken } = input;
  const candidate = providerCandidateCredentialSchema.parse({ ...input.candidate });
  if (candidate.kind !== command.actor.input.kind) throw new FirstPasswordRefusal('denied', 'invalid_proof');
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const context = await loadFirstPasswordChallenge(transaction, authority, runtime, command, ['prepared']);
    if (
      !context.challenge.pendingPasswordHash ||
      !context.challenge.preparedAt ||
      !context.challenge.preparationTokenHash ||
      !equalFirstPasswordDigest(
        context.challenge.preparationTokenHash,
        firstPasswordTokenHash('preparation', preparationToken),
      ) ||
      (candidate.kind === 'canonical-token' &&
        !equalFirstPasswordDigest(context.challenge.proposedCredentialHash ?? '', providerCredentialHash(candidate)))
    )
      throw new FirstPasswordRefusal('denied', 'invalid_proof');
    const browserPreparation = await prepareBrowserReplacementInTransaction(transaction, authority, {
      bindingToken: command.actor.input.browserBindingToken,
      intentToken: command.browserIntentToken,
      actor: { version: command.actor.input.browserVersion, credential: command.actor.credential },
      candidate: presentedCandidate(candidate, runtime),
      operationId: context.challenge.operationId,
      kind: 'password-set',
    });
    await context.identity.verifyEmail(
      context.session.userId,
      context.user.email,
      context.session.generation,
      context.challenge.preparedAt,
    );
    await context.identity.insertPassword(
      context.session.userId,
      context.challenge.pendingPasswordHash,
      context.session.generation,
    );
    const mutation = await recordIdentityPasswordMutation(
      transaction,
      {
        expectedProjectionId: authority.projectionId,
        expectedNormalizerVersion: authority.normalizerVersion,
        expectedWriterEpoch: authority.epoch,
        operationId: context.challenge.operationId,
        userId: context.session.userId,
        expectedGeneration: context.session.generation,
        kind: 'password-set',
        domains: ['first-party', 'partner'],
      },
      authority,
    );
    // The credential trigger already handles legacy/mirror-on writes. This
    // idempotent call also covers canonical primary with legacy mirroring off.
    await transaction.execute(sql`SELECT public.partner_revoke_user(${context.session.userId})`);
    const now = await providerDatabaseNow(transaction);
    await replaceProviderCanonicalContinuation(
      transaction,
      context.session,
      command.actor.credential,
      candidate,
      mutation.cutoff.generation,
      now,
    );
    const browser = await commitPreparedBrowserReplacementInTransaction(
      transaction,
      authority,
      browserPreparation,
      mutation.identityGenerationReceipt,
    );
    const finished = await providerDatabaseNow(transaction);
    const recoveryExpiresAt = new Date(
      Math.min(finished.getTime() + FIRST_PASSWORD_RECOVERY_LIFETIME_MS, contextDeadline(context)),
    );
    if (recoveryExpiresAt.getTime() <= finished.getTime()) throw new FirstPasswordRefusal('denied', 'expired');
    const candidateCredentialHash = providerCredentialHash(candidate);
    const [consumed] = await transaction
      .update(authFirstPasswordChallenges)
      .set({
        phase: 'committed',
        pendingPasswordHash: null,
        consumedAt: finished,
        candidateCredentialHash,
        recoveryExpiresAt,
      })
      .where(
        and(
          eq(authFirstPasswordChallenges.challengeHash, context.challenge.challengeHash),
          eq(authFirstPasswordChallenges.phase, 'prepared'),
          isNull(authFirstPasswordChallenges.consumedAt),
        ),
      )
      .returning({ hash: authFirstPasswordChallenges.challengeHash });
    if (!consumed) throw new FirstPasswordRefusal('denied', 'replayed');
    await revalidateIdentityAuthority(transaction, authority);
    await requireLastClock(transaction, Math.min(contextDeadline(context), recoveryExpiresAt.getTime()));
    return { outcome: 'committed' as const, candidateCredentialHash, browserCursor: browser.cursor };
  });
}

/** Lost backend ACK only; no old actor/confirmation token can retrieve a bearer. */
export async function acknowledgeFirstPasswordResult(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: FirstPasswordBoundInput & {
    readonly preparationToken: string;
    readonly recoveryToken: string;
    readonly candidate: ProviderCandidateCredential;
  },
) {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const command = captureFirstPasswordCommand(input, runtime);
  const { preparationToken, recoveryToken } = input;
  const candidate = providerCandidateCredentialSchema.parse({ ...input.candidate });
  const candidateHash = providerCredentialHash(candidate);
  const credential = presentedCandidate(candidate, runtime);
  const matches = (challenge: FirstPasswordChallenge | undefined) =>
    challenge !== undefined &&
    challenge.phase === 'committed' &&
    challenge.purpose === 'first-password' &&
    challenge.actorCredentialKind === command.actor.input.kind &&
    candidate.kind === challenge.actorCredentialKind &&
    equalFirstPasswordDigest(challenge.actorCredentialHash, command.actor.credentialHash) &&
    challenge.userId === command.actor.input.expectedUserId &&
    challenge.actorSessionId === command.actor.input.expectedAuthSessionId &&
    challenge.browserBindingHash === providerTokenHash(command.actor.input.browserBindingToken) &&
    challenge.browserVersion === command.actor.input.browserVersion &&
    challenge.browserIntentHash === providerTokenHash(command.browserIntentToken) &&
    equalFirstPasswordDigest(
      challenge.preparationTokenHash ?? '',
      firstPasswordTokenHash('preparation', preparationToken),
    ) &&
    equalFirstPasswordDigest(challenge.recoveryTokenHash, firstPasswordTokenHash('recovery', recoveryToken)) &&
    equalFirstPasswordDigest(challenge.candidateCredentialHash ?? '', candidateHash);
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const challengeHash = firstPasswordTokenHash('challenge', command.challengeToken);
    const [observed] = await transaction
      .select()
      .from(authFirstPasswordChallenges)
      .where(eq(authFirstPasswordChallenges.challengeHash, challengeHash));
    if (!matches(observed)) throw new FirstPasswordRefusal('denied', 'invalid_proof');
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
      throw new FirstPasswordRefusal('identity_changed', 'invalid_proof');
    const [challenge] = await transaction
      .select()
      .from(authFirstPasswordChallenges)
      .where(eq(authFirstPasswordChallenges.challengeHash, challengeHash))
      .for('update');
    if (!matches(challenge) || !challenge.recoveryExpiresAt || !challenge.consumedAt)
      throw new FirstPasswordRefusal('denied', 'replayed');
    await revalidateIdentityAuthority(transaction, authority);
    await requireLastClock(transaction, Math.min(challenge.expiresAt.getTime(), challenge.recoveryExpiresAt.getTime()));
    return { outcome: 'recovered' as const, candidateCredentialHash: candidateHash, browserCursor: admitted.cursor };
  });
}
