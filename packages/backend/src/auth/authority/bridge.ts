import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { authCredentialLineage, authSession, authSessionDenials } from '@boardsesh/db/schema/auth';
import { requireHumanSubjectForIssuance, AuthSubjectDeniedError } from '../human-admission';
import { decideCredential } from '../credential-cutoffs';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import { requireReadCommitted } from '../current-store/foundation-context';
import type { AuthorityDatabase } from './adapter';

export type LegacyBridgeMode = 'off' | 'shadow' | 'on';
export function legacyBridgeMode(environment: Readonly<Record<string, string | undefined>>): LegacyBridgeMode {
  const selector = environment.AUTH_LEGACY_BRIDGE_MODE;
  if (!selector || selector === 'off') return 'off';
  if (selector === 'shadow' || selector === 'on') return selector;
  throw new Error('Invalid AUTH_LEGACY_BRIDGE_MODE');
}
export type LegacyBridgeResult =
  | { status: 'off' | 'shadow' | 'denied' | 'unavailable' }
  | { status: 'bridged'; session: typeof authSession.$inferSelect };

/** Verify first, then gate → user → cutoff → session → lineage. No route is mounted. */
export async function bridgeLegacyCredential(
  database: AuthorityDatabase,
  credential: string,
  secret: string,
  mode: LegacyBridgeMode = legacyBridgeMode(process.env),
  now = new Date(),
): Promise<LegacyBridgeResult> {
  if (mode === 'off') return { status: 'off' };
  const proof = await verifyLegacyNextAuthJwe(credential, secret, now);
  if (!proof || proof.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
  try {
    return await database.transaction(async (transaction): Promise<LegacyBridgeResult> => {
      await requireReadCommitted(transaction);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      const subject = await requireHumanSubjectForIssuance(transaction, proof.userId);
      const sessionId = proof.authSessionId ?? proof.lineageId;
      // Serialize rotations of one login without serializing unrelated users.
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, hashtext(${proof.lineageId}))`);
      const [denial] = await transaction
        .select()
        .from(authSessionDenials)
        .where(eq(authSessionDenials.sessionId, sessionId));
      if (
        denial ||
        decideCredential(
          { kind: 'web-session', generationClaim: proof.generation, sessionKeyClaim: sessionId, authTimeClaim: null },
          subject,
          now.getTime(),
        ).denial !== null
      )
        return { status: 'denied' };
      const [existing] = await transaction.select().from(authSession).where(eq(authSession.id, sessionId));
      const [lineage] = await transaction
        .select()
        .from(authCredentialLineage)
        .where(eq(authCredentialLineage.id, proof.lineageId));
      if (
        lineage &&
        (lineage.revokedAt || lineage.userId !== proof.userId || lineage.sessionId !== sessionId || !existing)
      )
        return { status: 'denied' };
      if (
        existing &&
        (existing.userId !== proof.userId ||
          (existing.revocationGeneration ?? 0) !== proof.generation ||
          existing.legacyLineageId !== proof.lineageId)
      )
        return { status: 'denied' };
      if (mode === 'shadow') return { status: 'shadow' };
      // A missing lineage is not a denial. Preserve signed expiry and unknown
      // age; never substitute now or the current generation into the proof.
      const [session] = existing
        ? [existing]
        : await transaction
            .insert(authSession)
            .values({
              id: sessionId,
              token: randomBytes(32).toString('base64url'),
              userId: proof.userId,
              expiresAt: proof.expiresAt,
              createdAt: (proof.linkGuarded ? proof.originalAuthenticatedAt : null) ?? new Date(0),
              updatedAt: now,
              originalAuthenticatedAt: proof.linkGuarded ? proof.originalAuthenticatedAt : null,
              legacyLineageId: proof.lineageId,
              revocationGeneration: proof.generation,
            })
            .returning();
      // A valid renewed JWE may extend this login only to its signed expiry.
      // Keep the initial lineage source expiry and unknown/earlier auth age.
      if (existing && proof.expiresAt > existing.expiresAt) {
        const [renewed] = await transaction
          .update(authSession)
          .set({ expiresAt: proof.expiresAt, updatedAt: now })
          .where(eq(authSession.id, sessionId))
          .returning();
        session.expiresAt = renewed.expiresAt;
      }
      if (!lineage)
        await transaction.insert(authCredentialLineage).values({
          id: proof.lineageId,
          userId: proof.userId,
          sessionId,
          originalAuthenticatedAt: proof.originalAuthenticatedAt,
          originalExpiresAt: proof.expiresAt,
        });
      return { status: 'bridged', session };
    });
  } catch (error) {
    return { status: error instanceof AuthSubjectDeniedError ? 'denied' : 'unavailable' };
  }
}
