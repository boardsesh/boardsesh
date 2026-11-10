import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, sql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority, type PrototypeDatabase } from './authority';
import { PROTOTYPE_CONFIGURATION } from './configuration';
import { PrototypeResponseRollback, rejectPrototypeServerFailure } from './transaction-response';
import { invalidatePrototypeLegacyRecovery } from './legacy-recovery-state';
import { verifyLegacyWebCookie } from '../legacy-web-credentials';
import { hasPrototypeLegacySourceDenial, recordPrototypeCanonicalSignout } from './legacy-source-state';
import { invalidatePrototypeCanonicalVerification } from './verification-state';

export const PROTOTYPE_LEGACY_KEY = new TextEncoder().encode('boardsesh-disposable-legacy-verification-key-6975');
export const PROTOTYPE_LEGACY_WEB_SECRET = 'boardsesh-disposable-nextauth-verification-key-6975';
const MAX_LEGACY_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
// The installed native issuer reads its clock separately for iat and exp.
// Bound that encoder-read span without changing the nominal seven-day policy.
const LEGACY_NATIVE_ENCODER_READ_ALLOWANCE_SECONDS = 60;
// Match middleware/auth.ts validateMobileJwt; keep the signed expiry distinct.
export const PROTOTYPE_LEGACY_NATIVE_CLOCK_TOLERANCE_SECONDS = 60;

type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];
type LifecycleDatabase = PrototypeDatabase | PrototypeTransaction;

interface VerifiedLegacyProof {
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly validUntil: Date;
  readonly clockToleranceSeconds: number;
  readonly originalAuthenticatedAt: Date | null;
  readonly lineageId: string;
}

export async function verifyLegacyNativeProof(
  credential: string,
  currentTime = new Date(),
): Promise<VerifiedLegacyProof | null> {
  if (!Number.isFinite(currentTime.getTime())) return null;
  let identity: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload: identity } = await jwtVerify(credential, PROTOTYPE_LEGACY_KEY, {
      algorithms: ['HS256'],
      issuer: 'boardsesh',
      audience: 'boardsesh-mobile',
      requiredClaims: ['sub', 'iat', 'exp'],
      currentDate: currentTime,
      clockTolerance: PROTOTYPE_LEGACY_NATIVE_CLOCK_TOLERANCE_SECONDS,
    }));
  } catch {
    return null;
  }
  const issuedAt = identity.iat!;
  const expiresAt = identity.exp!;
  if (
    typeof identity.sub !== 'string' ||
    identity.sub.trim().length === 0 ||
    !Number.isInteger(issuedAt) ||
    !Number.isInteger(expiresAt) ||
    issuedAt * 1000 > currentTime.getTime() + PROTOTYPE_LEGACY_NATIVE_CLOCK_TOLERANCE_SECONDS * 1000 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_LEGACY_LIFETIME_SECONDS + LEGACY_NATIVE_ENCODER_READ_ALLOWANCE_SECONDS
  )
    return null;
  const authenticationTime = identity.auth_time;
  if (
    authenticationTime !== undefined &&
    (typeof authenticationTime !== 'number' ||
      !Number.isInteger(authenticationTime) ||
      authenticationTime < 0 ||
      authenticationTime > issuedAt ||
      authenticationTime * 1000 > currentTime.getTime())
  )
    return null;
  const stableSessionId =
    typeof identity.authSessionId === 'string' && identity.authSessionId.length > 0
      ? identity.authSessionId
      : undefined;
  return {
    userId: identity.sub,
    issuedAt: new Date(issuedAt * 1000),
    expiresAt: new Date(expiresAt * 1000),
    validUntil: new Date((expiresAt + PROTOTYPE_LEGACY_NATIVE_CLOCK_TOLERANCE_SECONDS) * 1000),
    clockToleranceSeconds: PROTOTYPE_LEGACY_NATIVE_CLOCK_TOLERANCE_SECONDS,
    originalAuthenticatedAt: typeof authenticationTime === 'number' ? new Date(authenticationTime * 1000) : null,
    lineageId: `${stableSessionId ? 'session' : 'credential'}:${createHash('sha256')
      .update(JSON.stringify([identity.sub, stableSessionId ?? credential]))
      .digest('hex')}`,
  };
}

async function verifiedRequestProof(request: Request | undefined): Promise<VerifiedLegacyProof | null> {
  if (!request) return null;
  const verifiedWebProof = await verifyLegacyWebCookie(request.headers.get('cookie'), PROTOTYPE_LEGACY_WEB_SECRET);
  // The prototype's canonical sessions never take a web cookie's sign-in time:
  // its BA-04 bridge proves freshness with its own cutoffs. Partner consent is
  // the production reader that does (auth/partner/first-party-session.ts).
  const webProof = verifiedWebProof && { ...verifiedWebProof, originalAuthenticatedAt: null };
  const authorization = request.headers.get('authorization');
  if (authorization === null) return webProof;
  if (!authorization.startsWith('Bearer ')) return null;
  const nativeProof = await verifyLegacyNativeProof(authorization.slice('Bearer '.length));
  if (!nativeProof || (webProof && nativeProof.userId !== webProof.userId)) return null;
  return nativeProof;
}

/** Persist security state in the same transaction as the credential mutation. */
export async function revokePrototypeUser(
  database: LifecycleDatabase,
  userId: string,
  revokePartners = true,
): Promise<number> {
  const revokedAt = new Date();
  // Session creation waits on this row (authority.ts) before trusting its
  // generation stamp. The cutoff row cannot do this job: the first reset has
  // none, and NO KEY UPDATE leaves concurrent foreign-key checks unblocked.
  await database
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .for('no key update');
  const [cutoff] = await database
    .insert(schema.prototypeUserCutoff)
    .values({ userId, revokedThrough: revokedAt })
    .onConflictDoUpdate({
      target: schema.prototypeUserCutoff.userId,
      set: {
        revokedThrough: sql`greatest(${schema.prototypeUserCutoff.revokedThrough}, excluded.revoked_through)`,
        generation: sql`${schema.prototypeUserCutoff.generation} + 1`,
      },
    })
    .returning({ generation: schema.prototypeUserCutoff.generation });
  await database
    .update(schema.prototypeLegacyLineage)
    .set({ revokedAt })
    .where(eq(schema.prototypeLegacyLineage.userId, userId));
  // Direct Drizzle operations avoid recursively invoking the session deletion hook.
  await database.delete(schema.session).where(eq(schema.session.userId, userId));
  if (revokePartners) {
    await invalidatePrototypeLegacyRecovery(database, userId);
    await invalidatePrototypeCanonicalVerification(database, userId);
    await database.delete(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.userId, userId));
    await database.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, userId));
    await database
      .delete(schema.prototypeOAuthRefreshAncestor)
      .where(eq(schema.prototypeOAuthRefreshAncestor.userId, userId));
    await database.delete(schema.oauthConsent).where(eq(schema.oauthConsent.userId, userId));
    await database
      .update(schema.prototypeOAuthConnection)
      .set({ generation: sql`${schema.prototypeOAuthConnection.generation} + 1`, revokedAt })
      .where(eq(schema.prototypeOAuthConnection.userId, userId));
  }
  return cutoff.generation;
}

function bridgePlugin(database: LifecycleDatabase): BetterAuthPlugin {
  return {
    id: 'boardsesh-disposable-legacy-bridge',
    endpoints: {
      prototypeLegacyBridge: createAuthEndpoint('/prototype-legacy-bridge', { method: 'POST' }, async (context) => {
        const proof = await verifiedRequestProof(context.request);
        if (!proof) throw new APIError('UNAUTHORIZED');
        const now = Date.now();
        if (proof.validUntil.getTime() <= now) throw new APIError('UNAUTHORIZED');
        const currentSession = await getSessionFromCtx(context);
        if (currentSession && currentSession.user.id !== proof.userId) throw new APIError('UNAUTHORIZED');
        const userId = proof.userId;
        const [user] = await database.select().from(schema.user).where(eq(schema.user.id, userId));
        const [cutoff] = await database
          .select()
          .from(schema.prototypeUserCutoff)
          .where(eq(schema.prototypeUserCutoff.userId, userId));
        // A credential minted before reset on an ahead-clock replica must not
        // appear newer than the authoritative cutoff. Preserve raw signed iat
        // in the decoder, but compare its conservative lower bound here.
        if (
          !user ||
          (cutoff && proof.issuedAt.getTime() - proof.clockToleranceSeconds * 1000 <= cutoff.revokedThrough.getTime())
        ) {
          throw new APIError('UNAUTHORIZED');
        }

        // Real historic native JWTs lack a stable session ID and auth_time. Their
        // exact fingerprint is idempotent; revocation must conservatively use an
        // account cutoff. Rolling iat is deliberately never used as fresh auth.
        const lineageId = proof.lineageId;
        const [lineage] = await database
          .select()
          .from(schema.prototypeLegacyLineage)
          .where(eq(schema.prototypeLegacyLineage.id, lineageId));
        let session: typeof schema.session.$inferSelect;
        if (lineage) {
          const [existingSession] = await database
            .select()
            .from(schema.session)
            .where(and(eq(schema.session.id, lineage.sessionId), eq(schema.session.userId, userId)));
          // A deleted canonical session is a tombstone, never a reason to mint again.
          if (lineage.revokedAt || !existingSession || existingSession.expiresAt.getTime() <= now) {
            throw new APIError('UNAUTHORIZED');
          }
          session = existingSession;
        } else {
          // A rolled issue time from an unfenced old issuer cannot establish
          // new authentication after an account security mutation.
          if (cutoff) throw new APIError('UNAUTHORIZED');
          if (await hasPrototypeLegacySourceDenial(database, userId)) throw new APIError('UNAUTHORIZED');
          const originalAuthenticatedAt = proof.originalAuthenticatedAt;
          const [createdSession] = await database
            .insert(schema.session)
            .values({
              id: randomUUID(),
              token: randomBytes(32).toString('hex'),
              userId,
              createdAt: originalAuthenticatedAt ?? new Date(0),
              updatedAt: new Date(now),
              expiresAt: proof.validUntil,
              originalAuthenticatedAt,
              legacyLineageId: lineageId,
            })
            .returning();
          session = createdSession;
          await database.insert(schema.prototypeLegacyLineage).values({
            id: lineageId,
            userId,
            sessionId: session.id,
            originalAuthenticatedAt,
            originalExpiresAt: proof.expiresAt,
          });
        }
        await setSessionCookie(context, { session, user });
        return context.json({ userId, sessionId: session.id });
      }),
    },
  };
}

/**
 * A coarse shared lock deliberately trades throughput for a decisive BA-01 proof.
 * Every operation uses one transaction-bound adapter, including lifecycle hooks.
 * This is not mounted by the application and is not a rollout-ready writer.
 */
export function createPrototypeLegacyHandler(database: PrototypeDatabase, afterPasswordMutation?: () => Promise<void>) {
  return async (request: Request): Promise<Response> => {
    try {
      return await database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
        const authority = createPrototypeAuthority(transaction, {
          plugins: [bridgePlugin(transaction)],
          emailAndPassword: {
            ...PROTOTYPE_CONFIGURATION.emailAndPassword,
            async onPasswordReset({ user }) {
              await revokePrototypeUser(transaction, user.id);
              await afterPasswordMutation?.();
            },
          },
          databaseHooks: {
            session: {
              delete: {
                async before(session) {
                  const [lineage] = await transaction
                    .select()
                    .from(schema.prototypeLegacyLineage)
                    .where(eq(schema.prototypeLegacyLineage.sessionId, session.id));
                  if (!lineage) {
                    // Pending old user-only proofs cannot be associated with
                    // this source session. Deny new unknown admissions without
                    // ending unrelated canonical sessions or partner grants.
                    await recordPrototypeCanonicalSignout(transaction, session);
                    return;
                  }
                  if (lineage.id.startsWith('credential:')) {
                    // Ordinary sign-out does not terminate approved partner connections.
                    await revokePrototypeUser(transaction, session.userId, false);
                  } else {
                    await transaction
                      .update(schema.prototypeLegacyLineage)
                      .set({ revokedAt: new Date() })
                      .where(eq(schema.prototypeLegacyLineage.id, lineage.id));
                  }
                },
              },
            },
            user: {
              delete: {
                async before(user) {
                  await revokePrototypeUser(transaction, user.id);
                },
              },
            },
          },
        });
        return rejectPrototypeServerFailure(await authority.handler(request));
      });
    } catch (error) {
      if (error instanceof PrototypeResponseRollback) return error.response;
      throw error;
    }
  };
}
