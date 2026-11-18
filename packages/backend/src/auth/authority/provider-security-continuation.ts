import { randomBytes } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  authCredentialLineage,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSession,
  authSessionDenials,
  mobileRefreshTokens,
} from '@boardsesh/db/schema/auth';
import type { AuthorityTransaction } from './adapter';
import type { FirstPartyCredential, FirstPartySession } from './session-reader';
import type { ProviderCandidateCredential } from './provider-security-result';
import { sessionTokenDigest } from './session-token';
import { keepCanonicalAfterSecurityMutation } from './security-session';
import {
  requireFirstPartyContinuationMutationReceipt,
  type IdentityGenerationMutationReceipt,
} from '../current-store/security-mutation-core';

/**
 * Requesting-device continuation with the same SID, a new generation and a NEW
 * token, original provenance kept. First password still uses it until #7596
 * B5c2; provider link and unlink use `continueProviderSessionInPlace`.
 */
export async function replaceProviderCanonicalContinuation(
  transaction: AuthorityTransaction,
  source: FirstPartySession,
  sourceCredential: FirstPartyCredential,
  candidate: ProviderCandidateCredential,
  generation: number,
  now: Date,
) {
  if (
    !Number.isSafeInteger(generation) ||
    generation !== source.generation + 1 ||
    sourceCredential.kind !== candidate.kind
  )
    throw new Error('PROVIDER_CONTINUATION_GENERATION_INVALID');
  const [denied] = await transaction
    .select()
    .from(authSessionDenials)
    .where(eq(authSessionDenials.sessionId, source.authSessionId));
  if (denied) throw new Error('PROVIDER_CONTINUATION_DENIED');
  // Lock first, read in a fresh statement: an unfenced pending token/owner change
  // cannot be overwritten based on the pre-wait row version.
  await transaction
    .select({ id: authSession.id })
    .from(authSession)
    .where(eq(authSession.id, source.authSessionId))
    .for('update');
  const [stored] = await transaction.select().from(authSession).where(eq(authSession.id, source.authSessionId));
  if (stored) {
    if (
      stored.userId !== source.userId ||
      (stored.revocationGeneration ?? 0) !== source.generation ||
      stored.originalAuthenticatedAt?.getTime() !== source.authenticatedAt?.getTime() ||
      stored.expiresAt.getTime() < source.expiresAt.getTime() ||
      (sourceCredential.kind === 'canonical-token' && stored.token !== sessionTokenDigest(sourceCredential.token)) ||
      (stored.legacyLineageId?.startsWith('credential:') ?? false) !== source.requiresAccountCutoff
    )
      throw new Error('PROVIDER_CONTINUATION_SOURCE_CHANGED');
    if (stored.legacyLineageId) {
      const [lineage] = await transaction
        .select()
        .from(authCredentialLineage)
        .where(eq(authCredentialLineage.id, stored.legacyLineageId));
      if (
        lineage &&
        (lineage.revokedAt !== null || lineage.userId !== source.userId || lineage.sessionId !== source.authSessionId)
      )
        throw new Error('PROVIDER_CONTINUATION_LINEAGE_CHANGED');
    }
    const token = candidate.kind === 'canonical-token' ? candidate.credential : randomBytes(32).toString('base64url');
    await transaction
      .update(authSession)
      .set({
        token: sessionTokenDigest(token),
        revocationGeneration: generation,
        updatedAt: now,
        expiresAt: source.expiresAt,
      })
      .where(and(eq(authSession.id, source.authSessionId), eq(authSession.userId, source.userId)));
  } else if (sourceCredential.kind === 'canonical-token') throw new Error('PROVIDER_CONTINUATION_SOURCE_MISSING');
  await revokeOtherFirstPartyCredentials(transaction, source, now);
}

/**
 * Provider link and unlink (#7596): the requesting web session continues with
 * the same id and token, its sign-in time and expiry untouched, at the
 * account's new generation; every other first-party credential of the account
 * ends. Call in the savepoint of the mutation, right after
 * `recordIdentitySecurityMutation`, with its receipt; any refusal throws so the
 * whole mutation rolls back.
 */
export async function continueProviderSessionInPlace(
  transaction: AuthorityTransaction,
  source: FirstPartySession,
  token: string,
  mutationReceipt: IdentityGenerationMutationReceipt,
  expected: { readonly operationId: string; readonly kind: 'provider-link' | 'provider-unlink' },
  now: Date,
): Promise<{ readonly generation: number }> {
  const generations = requireFirstPartyContinuationMutationReceipt(
    transaction,
    source.userId,
    mutationReceipt,
    expected,
  );
  if (generations.previousGeneration !== source.generation || generations.generation !== source.generation + 1)
    throw new Error('PROVIDER_CONTINUATION_GENERATION_INVALID');
  await keepCanonicalAfterSecurityMutation(transaction, source, token, generations.generation, now);
  await revokeOtherFirstPartyCredentials(transaction, source, now);
  return { generation: generations.generation };
}

/**
 * Ends every first-party credential of the account but the requesting
 * session: other web sessions, other legacy lineages, every native refresh
 * token, and pending password-recovery and email-verification links (their
 * purpose generations move, so a later link cannot revive an older one).
 */
async function revokeOtherFirstPartyCredentials(
  transaction: AuthorityTransaction,
  source: FirstPartySession,
  now: Date,
) {
  await transaction
    .update(authSession)
    .set({ expiresAt: now, updatedAt: now })
    .where(and(eq(authSession.userId, source.userId), ne(authSession.id, source.authSessionId)));
  await transaction
    .update(authCredentialLineage)
    .set({ revokedAt: now })
    .where(
      and(
        eq(authCredentialLineage.userId, source.userId),
        ne(authCredentialLineage.sessionId, source.authSessionId),
        isNull(authCredentialLineage.revokedAt),
      ),
    );
  await transaction
    .update(mobileRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(mobileRefreshTokens.userId, source.userId), isNull(mobileRefreshTokens.revokedAt)));
  // Subject generation already invalidates UID-bound and legacy receipts. Keep
  // each purpose monotone as well, so later issuance cannot revive an old link.
  await transaction
    .insert(authPasswordRecoveryState)
    .values({ userId: source.userId, purpose: 'password-reset', generation: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: [authPasswordRecoveryState.userId, authPasswordRecoveryState.purpose],
      set: { generation: sql`${authPasswordRecoveryState.generation} + 1`, updatedAt: now },
    });
  await transaction
    .update(authPasswordRecoveryTokens)
    .set({ supersededAt: now })
    .where(
      and(
        eq(authPasswordRecoveryTokens.userId, source.userId),
        isNull(authPasswordRecoveryTokens.consumedAt),
        isNull(authPasswordRecoveryTokens.supersededAt),
      ),
    );
  await transaction
    .insert(authEmailVerificationState)
    .values({ userId: source.userId, purpose: 'email-verification', generation: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: [authEmailVerificationState.userId, authEmailVerificationState.purpose],
      set: { generation: sql`${authEmailVerificationState.generation} + 1`, updatedAt: now },
    });
  await transaction
    .update(authEmailVerificationTokens)
    .set({ supersededAt: now })
    .where(
      and(
        eq(authEmailVerificationTokens.userId, source.userId),
        isNull(authEmailVerificationTokens.consumedAt),
        isNull(authEmailVerificationTokens.supersededAt),
      ),
    );
}
