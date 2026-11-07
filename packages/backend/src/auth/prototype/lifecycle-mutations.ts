import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, freshSessionMiddleware } from 'better-auth/api';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createPrototypeAuthority, type PrototypeAuthority, type PrototypeDatabase } from './authority';
import { PROTOTYPE_ISSUER } from './oauth-options';
import { PrototypeResponseRollback, rejectPrototypeServerFailure } from './transaction-response';
import { PROTOTYPE_CONFIGURATION } from './configuration';
import {
  createPrototypeCredentialContinuation,
  prototypeCredentialFailureWithoutCookies,
  readPrototypeCredentialSource,
  type PrototypeCredentialContext,
} from './credential-continuation';

export const PROTOTYPE_LIFECYCLE_PATHS = {
  changePassword: '/prototype-lifecycle/change-password',
  setPassword: '/prototype-lifecycle/set-password',
} as const;

export type PrototypeLifecycleMutation = 'password-change' | 'password-set';

interface LifecycleMutationOptions {
  readonly authority?: BetterAuthOptions;
  readonly afterMutation?: (mutation: PrototypeLifecycleMutation, userId: string) => Promise<void>;
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
          const continuation = createPrototypeCredentialContinuation(
            transaction,
            options.authority?.databaseHooks?.session?.create?.before,
          );

          async function finishPasswordMutation(
            context: PrototypeCredentialContext,
            mutation: PrototypeLifecycleMutation,
            operation: () => Promise<Response>,
          ) {
            const source = await readPrototypeCredentialSource(transaction, context);
            const response = await operation();
            rejectPrototypeServerFailure(response);
            if (!response.ok) return response;

            // User decision, 2026-11-04: keep this device signed in with a NEW
            // canonical session. Its authentication age remains the proven
            // original time; the trusted generation binds current eligibility.
            await continuation.replace(context, source, async () => {
              await options.afterMutation?.(mutation, source.userId);
            });
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
                  before: continuation.beforeSessionCreate,
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
        if (error instanceof PrototypeResponseRollback) return prototypeCredentialFailureWithoutCookies(error.response);
        throw error;
      }
    },
  };
}
