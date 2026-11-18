import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  authCredentialLineage,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSession,
  mobileRefreshTokens,
} from '@boardsesh/db/schema/auth';
import type { AuthorityTransaction } from './adapter';
import type { FirstPartySession } from './session-reader';
import { keepCanonicalAfterSecurityMutation } from './security-session';
import {
  requireFirstPartyContinuationMutationReceipt,
  type IdentityGenerationMutationReceipt,
} from '../current-store/security-mutation-core';

/**
 * Provider link, unlink and first password (#7596): the requesting web session continues with
 * the same id and token, its sign-in time and expiry untouched, at the
 * account's new generation; every other first-party credential of the account
 * ends. Call in the transaction of the mutation, right after it records the
 * generation (`recordIdentitySecurityMutation` or
 * `recordIdentityPasswordMutation`), with its receipt; any refusal throws so the
 * whole mutation rolls back.
 */
export async function continueProviderSessionInPlace(
  transaction: AuthorityTransaction,
  source: FirstPartySession,
  token: string,
  mutationReceipt: IdentityGenerationMutationReceipt,
  expected: {
    readonly operationId: string;
    readonly kind: 'provider-link' | 'provider-unlink' | 'password-set';
  },
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
