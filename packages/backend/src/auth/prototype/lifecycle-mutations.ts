import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, freshSessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority, type PrototypeAuthority, type PrototypeDatabase } from './authority';
import { revokePrototypeUser } from './legacy-bridge';
import { PROTOTYPE_ISSUER } from './oauth-options';
import { PrototypeResponseRollback, rejectPrototypeServerFailure } from './transaction-response';
import { prototypeSessionPassesRevocation } from './session-revocation';
import { PROTOTYPE_CONFIGURATION } from './configuration';

export const PROTOTYPE_LIFECYCLE_PATHS = {
  changePassword: '/prototype-lifecycle/change-password',
  setPassword: '/prototype-lifecycle/set-password',
} as const;

export type PrototypeLifecycleMutation = 'password-change' | 'password-set';

interface LifecycleMutationOptions {
  readonly authority?: BetterAuthOptions;
  readonly afterMutation?: (mutation: PrototypeLifecycleMutation, userId: string) => Promise<void>;
}

type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];
type CookieContext = Parameters<typeof setSessionCookie>[0];

function failedResponseWithoutCookies(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Supported-API proof only, never mounted by the application. Set-password is a
 * Better Auth server-only API; these explicitly named prototype endpoints do not
 * claim that the stock library exposes an HTTP /set-password contract.
 */
export function createPrototypeLifecycleMutations(database: PrototypeDatabase, options: LifecycleMutationOptions = {}) {
  return {
    async handler(request: Request): Promise<Response> {
      const requestPath = new URL(request.url).pathname;
      if (
        !Object.values(PROTOTYPE_LIFECYCLE_PATHS).some(
          (path) => requestPath === `${new URL(PROTOTYPE_ISSUER).pathname}${path}`,
        )
      ) {
        return new Response(null, { status: 404 });
      }
      try {
        return await database.transaction(async (transaction) => {
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
          let authority: PrototypeAuthority;
          let continuationSource: typeof schema.session.$inferSelect | undefined;

          async function finishPasswordMutation(
            context: CookieContext,
            mutation: PrototypeLifecycleMutation,
            operation: () => Promise<Response>,
          ) {
            const session = context.context.session;
            if (!session) throw new APIError('UNAUTHORIZED');
            const [source] = await transaction
              .select()
              .from(schema.session)
              .where(
                and(
                  eq(schema.session.id, session.session.id),
                  eq(schema.session.userId, session.user.id),
                  eq(schema.session.token, session.session.token),
                ),
              );
            const [cutoff] = await transaction
              .select()
              .from(schema.prototypeUserCutoff)
              .where(eq(schema.prototypeUserCutoff.userId, session.user.id));
            if (!source || !prototypeSessionPassesRevocation(source, cutoff)) throw new APIError('UNAUTHORIZED');
            const originalAuthenticatedAt =
              source.originalAuthenticatedAt ?? (source.legacyLineageId ? null : source.createdAt);
            if (
              !originalAuthenticatedAt ||
              originalAuthenticatedAt.getTime() !== source.createdAt.getTime() ||
              originalAuthenticatedAt.getTime() > Date.now()
            ) {
              throw new APIError('FORBIDDEN', {
                code: 'SESSION_NOT_FRESH',
                message: 'A proven recent authentication is required.',
              });
            }

            const response = await operation();
            rejectPrototypeServerFailure(response);
            if (!response.ok) return response;

            // This shared contract also supersedes legacy recovery bindings,
            // canonical sessions, native descendants and partner connections.
            const generation = await revokePrototypeUser(transaction, session.user.id);
            await invalidateCanonicalPasswordRecovery(transaction, session.user.id);
            continuationSource = { ...source, originalAuthenticatedAt };
            const replacement = await context.context.internalAdapter.createSession(source.userId);
            const [persistedReplacement] = replacement
              ? await transaction.select().from(schema.session).where(eq(schema.session.id, replacement.id))
              : [];
            if (
              !replacement ||
              !persistedReplacement ||
              replacement.userId !== source.userId ||
              persistedReplacement.userId !== source.userId ||
              replacement.id === source.id ||
              replacement.token === source.token ||
              persistedReplacement.token !== replacement.token ||
              persistedReplacement.revocationGeneration !== generation ||
              persistedReplacement.createdAt.getTime() !== source.createdAt.getTime() ||
              persistedReplacement.originalAuthenticatedAt?.getTime() !== originalAuthenticatedAt.getTime() ||
              persistedReplacement.expiresAt.getTime() !== source.expiresAt.getTime() ||
              persistedReplacement.legacyLineageId !== null
            ) {
              throw new APIError('INTERNAL_SERVER_ERROR');
            }
            await options.afterMutation?.(mutation, session.user.id);

            // User decision, 2026-11-04: keep this device signed in with a NEW
            // canonical session. Its authentication age remains the proven
            // original time; the trusted generation binds current eligibility.
            await setSessionCookie(context, { session: persistedReplacement, user: session.user });
            context.setHeader('cache-control', 'no-store');
            return context.json({ status: true, requiresSignIn: false });
          }

          const plugin: BetterAuthPlugin = {
            id: 'boardsesh-prototype-lifecycle-mutations',
            endpoints: {
              prototypeChangePassword: createAuthEndpoint(
                PROTOTYPE_LIFECYCLE_PATHS.changePassword,
                {
                  method: 'POST',
                  body: z.object({ currentPassword: z.string(), newPassword: z.string() }),
                  use: [freshSessionMiddleware],
                },
                async (context) =>
                  finishPasswordMutation(context, 'password-change', () =>
                    authority.api.changePassword({
                      headers: context.headers,
                      body: { ...context.body, revokeOtherSessions: false },
                      asResponse: true,
                    }),
                  ),
              ),
              prototypeSetPassword: createAuthEndpoint(
                PROTOTYPE_LIFECYCLE_PATHS.setPassword,
                {
                  method: 'POST',
                  body: z.object({ newPassword: z.string() }),
                  use: [freshSessionMiddleware],
                },
                async (context) =>
                  finishPasswordMutation(context, 'password-set', () =>
                    authority.api.setPassword({
                      headers: context.headers,
                      body: context.body,
                      asResponse: true,
                    }),
                  ),
              ),
            },
          };
          authority = createPrototypeAuthority(transaction, {
            ...options.authority,
            session: { ...options.authority?.session, freshAge: PROTOTYPE_CONFIGURATION.session.freshAge },
            advanced: { ...options.authority?.advanced, disableOriginCheck: false, disableCSRFCheck: false },
            databaseHooks: {
              ...options.authority?.databaseHooks,
              session: {
                ...options.authority?.databaseHooks?.session,
                create: {
                  ...options.authority?.databaseHooks?.session?.create,
                  async before(candidate, context) {
                    const previous = await options.authority?.databaseHooks?.session?.create?.before?.(
                      candidate,
                      context,
                    );
                    if (previous === false) return false;
                    if (!continuationSource) throw new APIError('INTERNAL_SERVER_ERROR');
                    return {
                      data: {
                        ...candidate,
                        ...(typeof previous === 'object' && previous !== null ? previous.data : {}),
                        userId: continuationSource.userId,
                        createdAt: continuationSource.createdAt,
                        updatedAt: new Date(),
                        expiresAt: continuationSource.expiresAt,
                        originalAuthenticatedAt: continuationSource.originalAuthenticatedAt,
                        legacyLineageId: null,
                      },
                    };
                  },
                },
              },
            },
            plugins: [plugin, ...(options.authority?.plugins ?? [])],
          });
          const response = await authority.handler(request);
          // Unlike OAuth reuse handling, these operations have no intentional
          // security mutation on error. Every unsuccessful result rolls back.
          if (!response.ok) throw new PrototypeResponseRollback(response);
          return response;
        });
      } catch (error) {
        if (error instanceof PrototypeResponseRollback) return failedResponseWithoutCookies(error.response);
        throw error;
      }
    },
  };
}

async function invalidateCanonicalPasswordRecovery(transaction: PrototypeTransaction, userId: string) {
  // Stock Better Auth password-reset records bind their value to the immutable
  // user ID. Changing a password must also supersede these newer recovery links.
  await transaction
    .delete(schema.verification)
    .where(and(like(schema.verification.identifier, 'reset-password:%'), eq(schema.verification.value, userId)));
}
