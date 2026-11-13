import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { authCredentialLineage, authSession, authSessionDenials } from '@boardsesh/db/schema/auth';
import type { AuthorityTransaction } from './adapter';
import type { FirstPartySession } from './session-reader';

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
  const token = randomBytes(32).toString('base64url');
  const [replaced] = await transaction
    .update(authSession)
    .set({
      token,
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
