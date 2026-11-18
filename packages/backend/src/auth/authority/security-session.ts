import { and, eq } from 'drizzle-orm';
import { authCredentialLineage, authSession, authSessionDenials } from '@boardsesh/db/schema/auth';
import type { AuthorityTransaction } from './adapter';
import type { FirstPartySession } from './session-reader';
import { newSessionToken, sessionTokenDigest } from './session-token';

/** Caller owns gate/user/cutoff locks and has just advanced the admitted actor's generation. */
export async function replaceCanonicalAfterSecurityMutation(
  transaction: AuthorityTransaction,
  actor: FirstPartySession,
  newGeneration: number,
  now = new Date(),
): Promise<{ token: string } | undefined> {
  if (!Number.isSafeInteger(newGeneration) || newGeneration !== actor.generation + 1)
    throw new Error('SESSION_REPLACEMENT_GENERATION_MISMATCH');
  const [denial] = await transaction
    .select()
    .from(authSessionDenials)
    .where(eq(authSessionDenials.sessionId, actor.authSessionId));
  if (denial) throw new Error('SESSION_REPLACEMENT_DENIED');
  const [session] = await transaction.select().from(authSession).where(eq(authSession.id, actor.authSessionId));
  if (!session) return undefined;
  if (session.userId !== actor.userId || (session.revocationGeneration ?? 0) !== actor.generation)
    throw new Error('SESSION_REPLACEMENT_SOURCE_MISMATCH');
  if (session.legacyLineageId) {
    const [lineage] = await transaction
      .select()
      .from(authCredentialLineage)
      .where(eq(authCredentialLineage.id, session.legacyLineageId));
    if (lineage && (lineage.revokedAt || lineage.userId !== actor.userId || lineage.sessionId !== actor.authSessionId))
      throw new Error('SESSION_REPLACEMENT_LINEAGE_MISMATCH');
  }
  const { token, stored } = newSessionToken();
  const [replaced] = await transaction
    .update(authSession)
    .set({
      token: stored,
      revocationGeneration: newGeneration,
      updatedAt: now,
      expiresAt: new Date(Math.min(session.expiresAt.getTime(), actor.expiresAt.getTime())),
      // Neither proof age nor createdAt is refreshed by a password mutation.
    })
    .where(and(eq(authSession.id, actor.authSessionId), eq(authSession.userId, actor.userId)))
    .returning({ id: authSession.id });
  if (!replaced) throw new Error('SESSION_REPLACEMENT_SOURCE_MISSING');
  return { token };
}

/**
 * The in-place counterpart of `replaceCanonicalAfterSecurityMutation`, for the
 * flows that keep the session token (#7596: provider link and unlink; only
 * login and sign-out write the cookie). The caller holds the gate, user and
 * cutoff locks and has just advanced the account's generation to
 * `newGeneration`. This moves the requesting session alone to it: same id,
 * same token, same sign-in time, same expiry. Every other session of the
 * account keeps the old generation, so every reader refuses it.
 *
 * It refuses, and the caller's transaction must roll back, when the row no
 * longer carries `token`, is denied, has moved to another generation or
 * sign-in time, or its legacy lineage was revoked.
 */
export async function keepCanonicalAfterSecurityMutation(
  transaction: AuthorityTransaction,
  actor: FirstPartySession,
  token: string,
  newGeneration: number,
  now = new Date(),
): Promise<void> {
  if (!Number.isSafeInteger(newGeneration) || newGeneration !== actor.generation + 1)
    throw new Error('SESSION_CONTINUATION_GENERATION_MISMATCH');
  const [denial] = await transaction
    .select()
    .from(authSessionDenials)
    .where(eq(authSessionDenials.sessionId, actor.authSessionId));
  if (denial) throw new Error('SESSION_CONTINUATION_DENIED');
  // Lock first, then read in a fresh statement: a roll or sign-out that was
  // waiting is seen as committed, never overwritten from an older row version.
  await transaction
    .select({ id: authSession.id })
    .from(authSession)
    .where(eq(authSession.id, actor.authSessionId))
    .for('update');
  const [session] = await transaction.select().from(authSession).where(eq(authSession.id, actor.authSessionId));
  if (
    !session ||
    session.userId !== actor.userId ||
    session.token !== sessionTokenDigest(token) ||
    (session.revocationGeneration ?? 0) !== actor.generation ||
    session.originalAuthenticatedAt?.getTime() !== actor.authenticatedAt?.getTime() ||
    (session.legacyLineageId?.startsWith('credential:') ?? false) !== actor.requiresAccountCutoff ||
    session.expiresAt.getTime() <= now.getTime()
  )
    throw new Error('SESSION_CONTINUATION_SOURCE_MISMATCH');
  if (session.legacyLineageId) {
    const [lineage] = await transaction
      .select()
      .from(authCredentialLineage)
      .where(eq(authCredentialLineage.id, session.legacyLineageId));
    if (lineage && (lineage.revokedAt || lineage.userId !== actor.userId || lineage.sessionId !== actor.authSessionId))
      throw new Error('SESSION_CONTINUATION_LINEAGE_MISMATCH');
  }
  const [kept] = await transaction
    .update(authSession)
    // Only the generation and the write time. Token, expiry, createdAt and
    // originalAuthenticatedAt stay: a link is not a sign-in.
    .set({ revocationGeneration: newGeneration, updatedAt: now })
    .where(
      and(
        eq(authSession.id, actor.authSessionId),
        eq(authSession.userId, actor.userId),
        eq(authSession.token, sessionTokenDigest(token)),
      ),
    )
    .returning({ id: authSession.id });
  if (!kept) throw new Error('SESSION_CONTINUATION_SOURCE_MISSING');
}
