import crypto from 'node:crypto';
import { and, eq, isNull, sql, like } from 'drizzle-orm';
import {
  authEmailProjection,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  authSession,
  authCredentialLineage,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema/auth';
import { notificationDevices } from '@boardsesh/db/schema/app';
import type { AuthorityDatabase } from './adapter';
import { AuthSubjectDeniedError } from '../human-admission';
import { decideCredential } from '../credential-cutoffs';
import { requireReadCommitted } from '../current-store/foundation-context';
import { transactionSettings } from '../current-store/command-context';

/** One native-only revocation: gate → user → cutoff → refresh → devices. */
export async function revokeNativeCredentials(database: AuthorityDatabase, tokenHash: string): Promise<boolean> {
  // Discovery never locks a child before its user: reset holds the user
  // before touching refresh rows. Recheck the secret after that lock.
  const [candidate] = await database
    .select({ userId: mobileRefreshTokens.userId })
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.tokenHash, tokenHash));
  if (!candidate) return false;
  const matchedToken = await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    await requireReadCommitted(transaction);
    await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
    const [subject] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .for('update');
    if (!subject) return null;
    const [matchingToken] = await transaction
      .select()
      .from(mobileRefreshTokens)
      .where(
        and(
          eq(mobileRefreshTokens.tokenHash, tokenHash),
          eq(mobileRefreshTokens.userId, candidate.userId),
          isNull(mobileRefreshTokens.revokedAt),
        ),
      );
    if (!matchingToken || matchingToken.expiresAt.getTime() <= Date.now()) return null;
    const [previousCutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, candidate.userId));
    if (
      previousCutoff?.deletedAt ||
      decideCredential(
        {
          kind: 'native-refresh',
          subjectGeneration: matchingToken.subjectGeneration,
          nativeGeneration: matchingToken.nativeGeneration,
          authenticatedAt: matchingToken.authenticatedAt,
        },
        {
          generation: previousCutoff?.generation ?? 0,
          nativeGeneration: previousCutoff?.nativeGeneration ?? 0,
          deniedSessionKeys: new Set<string>(),
        },
        Date.now(),
      ).denial !== null
    )
      return null;
    // App sign-out ends native credentials only, including issued JWTs.
    // Web generations stay unchanged (owner decision 10).
    const [nativeCutoff] = await transaction
      .insert(authSubjectCutoffs)
      .values({
        userId: candidate.userId,
        generation: 0,
        nativeGeneration: 1,
        // Native sign-out must not advance the account-wide age cutoff.
        revokedThrough: new Date(0),
        lastOperationId: crypto.randomUUID(),
      })
      .onConflictDoUpdate({
        target: authSubjectCutoffs.userId,
        set: {
          nativeGeneration: sql`${authSubjectCutoffs.nativeGeneration} + 1`,
          lastOperationId: crypto.randomUUID(),
        },
      })
      .returning();
    const [manifest] = await transaction
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    await transaction.insert(authSecurityMutationEvents).values({
      operationId: nativeCutoff.lastOperationId,
      userId: candidate.userId,
      kind: 'native-signout',
      generation: nativeCutoff.generation,
      previousGeneration: nativeCutoff.generation,
      nativeGeneration: nativeCutoff.nativeGeneration,
      previousNativeGeneration: nativeCutoff.nativeGeneration - 1,
      domains: ['first-party'],
      revokedThrough: new Date(),
      writerEpoch: manifest?.phase === 'enforced' ? manifest.writerEpoch : 0,
      projectionId: manifest?.phase === 'enforced' ? manifest.projectionId : 'legacy-native',
    });
    await transaction
      .delete(authSession)
      .where(and(eq(authSession.userId, candidate.userId), like(authSession.legacyLineageId, 'native-refresh:%')));
    const matchingRows = await transaction
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileRefreshTokens.tokenHash, tokenHash), isNull(mobileRefreshTokens.revokedAt)))
      .returning({ userId: mobileRefreshTokens.userId });

    if (!matchingRows[0]) throw new AuthSubjectDeniedError();

    // This endpoint signs out the whole account. The refresh secret remains
    // usable when the JWT has expired, so retire push devices in the same
    // transaction as token revocation rather than relying on bearer cleanup.
    await transaction
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileRefreshTokens.userId, matchingToken.userId), isNull(mobileRefreshTokens.revokedAt)));
    await transaction
      .update(authCredentialLineage)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(authCredentialLineage.userId, candidate.userId), like(authCredentialLineage.id, 'native-refresh:%')),
      );
    await transaction
      .update(notificationDevices)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(notificationDevices.userId, matchingToken.userId));
    return matchingToken;
  });

  return matchedToken !== null;
}
