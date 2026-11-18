import { and, eq, lt, sql } from 'drizzle-orm';
import { authCredentialLineage, authSession, authSessionDenials } from '@boardsesh/db/schema/auth';
import { requireHumanSubjectForIssuance, AuthSubjectDeniedError } from '../human-admission';
import { decideCredential } from '../credential-cutoffs';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import {
  lockEnforcedProjection,
  requireReadCommitted,
  type ExpectedCurrentStoreAuthority,
} from '../current-store/foundation-context';
import { transactionSettings } from '../current-store/command-context';
import type { AuthorityDatabase } from './adapter';
import { bridgedSessionToken, type BridgeTokenKey } from './session-token';

export type LegacyBridgeMode = 'off' | 'shadow' | 'on';
export function legacyBridgeMode(environment: Readonly<Record<string, string | undefined>>): LegacyBridgeMode {
  const selector = environment.AUTH_LEGACY_BRIDGE_MODE;
  if (!selector || selector === 'off') return 'off';
  if (selector === 'shadow' || selector === 'on') return selector;
  throw new Error('Invalid AUTH_LEGACY_BRIDGE_MODE');
}
/** The bridged row without its `token` column, which holds only a digest that never authenticates. */
export type BridgedSessionRow = Omit<typeof authSession.$inferSelect, 'token'>;
export type LegacyBridgeResult =
  | { status: 'off' | 'shadow' | 'denied' | 'unavailable' }
  | {
      status: 'bridged';
      session: BridgedSessionRow;
      /**
       * The raw session token, on every call: it is derived from the session id
       * under the bridge key (`bridgedSessionToken`), so the same legacy login
       * always bridges to the same token and a browser that lost a reply gets
       * it again (#7596, owner decision 3). The row stores only its digest.
       */
      token: string;
    };

/**
 * Verify first, then gate → manifest → user → cutoff → session → lineage. The
 * web bridge command (`bridgeWebSession`) passes `mode` 'on' behind its own
 * switch and always passes `authority`; the default reads
 * `AUTH_LEGACY_BRIDGE_MODE`.
 *
 * With `authority`, the bridge writes only under an enforced manifest with the
 * configured projection and writer epoch, as login does; anything else is
 * `unavailable`, never a denial. The transaction runs under the commands'
 * statement and lock timeouts, so a bridge queued behind a held account ends
 * as `unavailable` instead of holding a connection.
 *
 * A row for this login whose token is not the one the key derives (rotated by
 * a security mutation, written before the derived token, or derived under a
 * rotated key) is never re-keyed: the bridge answers `denied` and writes
 * nothing, so the climber signs in again.
 */
export async function bridgeLegacyCredential(
  database: AuthorityDatabase,
  credential: string,
  secret: string,
  tokenKey: BridgeTokenKey,
  mode: LegacyBridgeMode = legacyBridgeMode(process.env),
  now = new Date(),
  authority?: ExpectedCurrentStoreAuthority,
): Promise<LegacyBridgeResult> {
  if (mode === 'off') return { status: 'off' };
  const proof = await verifyLegacyNextAuthJwe(credential, secret, now);
  if (!proof || proof.expiresAt.getTime() <= now.getTime()) return { status: 'denied' };
  try {
    return await database.transaction(async (transaction): Promise<LegacyBridgeResult> => {
      await transactionSettings(transaction);
      await requireReadCommitted(transaction);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      if (authority) await lockEnforcedProjection(transaction, authority);
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
      const issued = bridgedSessionToken(tokenKey, sessionId);
      if (existing && existing.token !== issued.stored) return { status: 'denied' };
      if (mode === 'shadow') return { status: 'shadow' };
      // A missing lineage is not a denial. Preserve signed expiry and unknown
      // age; never substitute now or the current generation into the proof.
      const [session] = existing
        ? [existing]
        : await transaction
            .insert(authSession)
            .values({
              id: sessionId,
              token: issued.stored,
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
      // The WHERE re-reads the row under its lock, so a roll that committed
      // since `existing` was read is never shortened back.
      if (existing && proof.expiresAt > existing.expiresAt) {
        await transaction
          .update(authSession)
          .set({ expiresAt: proof.expiresAt, updatedAt: now })
          .where(and(eq(authSession.id, sessionId), lt(authSession.expiresAt, proof.expiresAt)));
        const [current] = await transaction
          .select({ expiresAt: authSession.expiresAt })
          .from(authSession)
          .where(eq(authSession.id, sessionId));
        session.expiresAt = current.expiresAt;
      }
      if (!lineage)
        await transaction.insert(authCredentialLineage).values({
          id: proof.lineageId,
          userId: proof.userId,
          sessionId,
          originalAuthenticatedAt: proof.originalAuthenticatedAt,
          originalExpiresAt: proof.expiresAt,
        });
      const { token: _storedDigest, ...bridged } = session;
      return { status: 'bridged', session: bridged, token: issued.token };
    });
  } catch (error) {
    return { status: error instanceof AuthSubjectDeniedError ? 'denied' : 'unavailable' };
  }
}
