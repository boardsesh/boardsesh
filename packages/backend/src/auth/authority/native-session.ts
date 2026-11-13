import type { NativeRevocationMode } from './native-revocation-configuration';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { authCredentialLineage, authSession, authSessionDenials } from '@boardsesh/db/schema/auth';
import type { AuthorityTransaction } from './adapter';
import { legacyBridgeMode } from './bridge';
import { AuthSubjectDeniedError } from '../human-admission';

interface RefreshSessionProof {
  readonly sessionId: string;
  readonly subjectGeneration: number;
  readonly authenticatedAt: Date | null;
}

/** Called only under the refresh issuer's gate/user lock, after generation admission. */
export async function bindNativeRefreshSession(
  transaction: AuthorityTransaction,
  userId: string,
  proof: RefreshSessionProof,
  sourceExpiresAt: Date,
  now = new Date(),
  revocationMode: NativeRevocationMode = 'legacy',
): Promise<void> {
  const mode = legacyBridgeMode(process.env);
  if (mode === 'off') return;
  if (mode === 'on' && revocationMode !== 'generation')
    throw new Error('NATIVE_CANONICAL_ISSUANCE_REQUIRES_GENERATION_REVOCATION');
  const lineageId = `native-refresh:${createHash('sha256')
    .update(JSON.stringify([userId, proof.sessionId]))
    .digest('hex')}`;
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, hashtext(${lineageId}))`);
  const [denial] = await transaction
    .select()
    .from(authSessionDenials)
    .where(eq(authSessionDenials.sessionId, proof.sessionId));
  const [session] = await transaction.select().from(authSession).where(eq(authSession.id, proof.sessionId));
  const [lineage] = await transaction
    .select()
    .from(authCredentialLineage)
    .where(eq(authCredentialLineage.id, lineageId));
  if (
    denial ||
    (lineage &&
      (lineage.revokedAt || lineage.userId !== userId || lineage.sessionId !== proof.sessionId || !session)) ||
    (session &&
      (session.userId !== userId ||
        session.legacyLineageId !== lineageId ||
        session.revocationGeneration !== proof.subjectGeneration))
  )
    throw new AuthSubjectDeniedError();
  if (mode === 'shadow') return;
  if (!session) {
    await transaction.insert(authSession).values({
      id: proof.sessionId,
      token: randomBytes(32).toString('base64url'),
      userId,
      expiresAt: sourceExpiresAt,
      createdAt: proof.authenticatedAt ?? new Date(0),
      updatedAt: now,
      originalAuthenticatedAt: proof.authenticatedAt,
      legacyLineageId: lineageId,
      revocationGeneration: proof.subjectGeneration,
    });
  } else if (session.expiresAt < sourceExpiresAt) {
    await transaction
      .update(authSession)
      .set({ expiresAt: sourceExpiresAt, updatedAt: now })
      .where(and(eq(authSession.id, proof.sessionId), eq(authSession.userId, userId)));
  }
  if (!lineage)
    await transaction.insert(authCredentialLineage).values({
      id: lineageId,
      userId,
      sessionId: proof.sessionId,
      originalAuthenticatedAt: proof.authenticatedAt,
      originalExpiresAt: sourceExpiresAt,
    });
}
