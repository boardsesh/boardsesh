import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hash } from 'bcryptjs';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import { setPasswordPasswordSchema } from '@boardsesh/auth-protocol';
import { authFirstPasswordChallenges } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
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
import {
  admitProviderActorInTransaction,
  providerDatabaseNow,
  providerWebSessionHash,
  ProviderSecurityRefusal,
  requireCanonicalProviderActor,
} from './provider-security-context';
import { recordIdentityPasswordMutation } from './password-mutation';
import { continueProviderSessionInPlace } from './provider-security-continuation';
import { revalidateIdentityAuthority } from './router';

type Context = Awaited<ReturnType<typeof loadFirstPasswordChallenge>>;
function contextDeadline(context: Context): number {
  return Math.min(context.challenge.expiresAt.getTime(), context.session.expiresAt.getTime());
}
async function requireLastClock(transaction: AuthorityTransaction, expiresAt: number): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || (await providerDatabaseNow(transaction)).getTime() >= expiresAt)
    throw new FirstPasswordRefusal('denied', 'expired');
}

/** Email ownership permits only preparing a first password. It creates no
 * provider reauthentication receipt, mints no token and never changes the
 * original session age. */
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
  const validPassword = setPasswordPasswordSchema.safeParse(password);
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
        // No token is minted: the credential that continues is the presented
        // one, and a prepared canonical row must name it.
        proposedCredentialHash: context.challenge.actorCredentialHash,
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
      expiresAt,
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

/**
 * Every password/mirror/cutoff/revocation/challenge write below uses this one
 * physical transaction and rolls back on any late refusal. The requesting
 * session keeps its id, token, sign-in time and expiry and moves to the
 * account's new generation; every other first-party credential ends.
 */
export async function finalizeFirstPasswordChallenge(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: FirstPasswordBoundInput & { readonly preparationToken: string },
) {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const command = captureFirstPasswordCommand(input, runtime);
  const { preparationToken } = input;
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const context = await loadFirstPasswordChallenge(transaction, authority, runtime, command, ['prepared']);
    const { token } = requireCanonicalProviderActor(command.actor);
    if (
      !context.challenge.pendingPasswordHash ||
      !context.challenge.preparedAt ||
      !context.challenge.preparationTokenHash ||
      !equalFirstPasswordDigest(
        context.challenge.preparationTokenHash,
        firstPasswordTokenHash('preparation', preparationToken),
      ) ||
      !equalFirstPasswordDigest(context.challenge.proposedCredentialHash ?? '', context.challenge.actorCredentialHash)
    )
      throw new FirstPasswordRefusal('denied', 'invalid_proof');
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
    const continued = await continueProviderSessionInPlace(
      transaction,
      context.session,
      token,
      mutation.identityGenerationReceipt,
      { operationId: context.challenge.operationId, kind: 'password-set' },
      now,
    );
    const finished = await providerDatabaseNow(transaction);
    const recoveryExpiresAt = new Date(
      Math.min(finished.getTime() + FIRST_PASSWORD_RECOVERY_LIFETIME_MS, contextDeadline(context)),
    );
    if (recoveryExpiresAt.getTime() <= finished.getTime()) throw new FirstPasswordRefusal('denied', 'expired');
    const [consumed] = await transaction
      .update(authFirstPasswordChallenges)
      .set({
        phase: 'committed',
        pendingPasswordHash: null,
        consumedAt: finished,
        // The credential that continues is the presented one.
        candidateCredentialHash: context.challenge.actorCredentialHash,
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
    return { outcome: 'committed' as const, generation: continued.generation };
  });
}

/**
 * Lost backend ACK only: answers whether this exact challenge committed, for
 * the session that made it, at the generation it then got. No old actor or
 * confirmation token retrieves a bearer.
 */
export async function acknowledgeFirstPasswordResult(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: FirstPasswordBoundInput & { readonly preparationToken: string; readonly recoveryToken: string },
) {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const command = captureFirstPasswordCommand(input, runtime);
  const { preparationToken, recoveryToken } = input;
  const matches = (challenge: FirstPasswordChallenge | undefined) =>
    challenge !== undefined &&
    challenge.phase === 'committed' &&
    challenge.purpose === 'first-password' &&
    challenge.actorCredentialKind === command.actor.input.presented.kind &&
    equalFirstPasswordDigest(challenge.actorCredentialHash, command.actor.credentialHash) &&
    challenge.userId === command.actor.input.expectedUserId &&
    challenge.actorSessionId === command.actor.input.expectedAuthSessionId &&
    // These two compare stored values with stored values: they check the row's
    // shape (a web-session row, not a binding row), not the caller. The caller
    // is proven by the token hash and ids above and the admission below.
    challenge.browserBindingHash === providerWebSessionHash(challenge.actorSessionId) &&
    equalFirstPasswordDigest(
      challenge.preparationTokenHash ?? '',
      firstPasswordTokenHash('preparation', preparationToken),
    ) &&
    equalFirstPasswordDigest(challenge.recoveryTokenHash, firstPasswordTokenHash('recovery', recoveryToken)) &&
    equalFirstPasswordDigest(challenge.candidateCredentialHash ?? '', challenge.actorCredentialHash);
  return withFirstPasswordAuthority(database, runtime, async (transaction, authority) => {
    const challengeHash = firstPasswordTokenHash('challenge', command.challengeToken);
    // A preliminary read; user admission precedes the challenge row lock.
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
    const { session } = await admitProviderActorInTransaction(transaction, authority, command.actor);
    if (
      session.userId !== observed.userId ||
      session.authSessionId !== observed.actorSessionId ||
      session.generation !== observed.actorGeneration + 1 ||
      session.authenticatedAt?.getTime() !== observed.actorAuthenticatedAt?.getTime() ||
      session.linkGuarded !== observed.actorLinkGuarded ||
      session.requiresAccountCutoff !== observed.actorRequiresAccountCutoff
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
    return { outcome: 'recovered' as const, generation: session.generation };
  });
}
