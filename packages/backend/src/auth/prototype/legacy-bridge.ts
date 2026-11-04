import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, sql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority, type PrototypeDatabase } from './authority';
import { PROTOTYPE_CONFIGURATION } from './configuration';
import { PrototypeResponseRollback, rejectPrototypeServerFailure } from './transaction-response';

export const PROTOTYPE_LEGACY_KEY = new TextEncoder().encode('boardsesh-disposable-legacy-verification-key-6975');
const MAX_LEGACY_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];
type LifecycleDatabase = PrototypeDatabase | PrototypeTransaction;

/** Persist security state in the same transaction as the credential mutation. */
export async function revokePrototypeUser(
  database: LifecycleDatabase,
  userId: string,
  revokePartners = true,
): Promise<void> {
  const revokedAt = new Date();
  await database
    .insert(schema.prototypeUserCutoff)
    .values({ userId, revokedThrough: revokedAt })
    .onConflictDoUpdate({
      target: schema.prototypeUserCutoff.userId,
      set: { revokedThrough: sql`greatest(${schema.prototypeUserCutoff.revokedThrough}, excluded.revoked_through)` },
    });
  await database
    .update(schema.prototypeLegacyLineage)
    .set({ revokedAt })
    .where(eq(schema.prototypeLegacyLineage.userId, userId));
  // Direct Drizzle operations avoid recursively invoking the session deletion hook.
  await database.delete(schema.session).where(eq(schema.session.userId, userId));
  if (revokePartners) {
    await database.delete(schema.oauthAccessToken).where(eq(schema.oauthAccessToken.userId, userId));
    await database.delete(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, userId));
    await database.delete(schema.oauthConsent).where(eq(schema.oauthConsent.userId, userId));
    await database
      .update(schema.prototypeOAuthConnection)
      .set({ generation: sql`${schema.prototypeOAuthConnection.generation} + 1`, revokedAt })
      .where(eq(schema.prototypeOAuthConnection.userId, userId));
  }
}

function bridgePlugin(database: LifecycleDatabase): BetterAuthPlugin {
  return {
    id: 'boardsesh-disposable-legacy-bridge',
    endpoints: {
      prototypeLegacyBridge: createAuthEndpoint('/prototype-legacy-bridge', { method: 'POST' }, async (context) => {
        const authorization = context.request?.headers.get('authorization');
        if (!authorization?.startsWith('Bearer ')) throw new APIError('UNAUTHORIZED');
        const credential = authorization.slice('Bearer '.length);
        let identity: Awaited<ReturnType<typeof jwtVerify>>['payload'];
        try {
          ({ payload: identity } = await jwtVerify(credential, PROTOTYPE_LEGACY_KEY, {
            algorithms: ['HS256'],
            issuer: 'boardsesh',
            audience: 'boardsesh-mobile',
            requiredClaims: ['sub', 'iat', 'exp'],
          }));
        } catch {
          throw new APIError('UNAUTHORIZED');
        }
        const issuedAt = identity.iat!;
        const expiresAt = identity.exp!;
        const now = Date.now();
        if (
          !identity.sub ||
          !Number.isInteger(issuedAt) ||
          !Number.isInteger(expiresAt) ||
          issuedAt * 1000 > now ||
          expiresAt <= issuedAt ||
          expiresAt - issuedAt > MAX_LEGACY_LIFETIME_SECONDS
        )
          throw new APIError('UNAUTHORIZED');
        const authenticationTime = identity.auth_time;
        if (
          authenticationTime !== undefined &&
          (typeof authenticationTime !== 'number' ||
            !Number.isInteger(authenticationTime) ||
            authenticationTime < 0 ||
            authenticationTime > issuedAt)
        )
          throw new APIError('UNAUTHORIZED');

        const userId = identity.sub;
        const [user] = await database.select().from(schema.user).where(eq(schema.user.id, userId));
        const [cutoff] = await database
          .select()
          .from(schema.prototypeUserCutoff)
          .where(eq(schema.prototypeUserCutoff.userId, userId));
        if (!user || (cutoff && issuedAt * 1000 <= cutoff.revokedThrough.getTime())) throw new APIError('UNAUTHORIZED');

        // Real historic native JWTs lack a stable session ID and auth_time. Their
        // exact fingerprint is idempotent; revocation must conservatively use an
        // account cutoff. Rolling iat is deliberately never used as fresh auth.
        const stableSessionId =
          typeof identity.authSessionId === 'string' && identity.authSessionId.length > 0
            ? identity.authSessionId
            : undefined;
        const lineageId = `${stableSessionId ? 'session' : 'credential'}:${createHash('sha256')
          .update(JSON.stringify([userId, stableSessionId ?? credential]))
          .digest('hex')}`;
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
          const originalAuthenticatedAt =
            typeof authenticationTime === 'number' ? new Date(authenticationTime * 1000) : null;
          const [createdSession] = await database
            .insert(schema.session)
            .values({
              id: randomUUID(),
              token: randomBytes(32).toString('hex'),
              userId,
              createdAt: originalAuthenticatedAt ?? new Date(0),
              updatedAt: new Date(now),
              expiresAt: new Date(expiresAt * 1000),
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
            originalExpiresAt: new Date(expiresAt * 1000),
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
                  if (!lineage) return;
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
