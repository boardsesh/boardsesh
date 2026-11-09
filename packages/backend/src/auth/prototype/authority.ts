import { betterAuth, type Auth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { oauthProvider } from '@better-auth/oauth-provider';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { PROTOTYPE_CONFIGURATION } from './configuration';
import { PROTOTYPE_OAUTH_OPTIONS } from './oauth-options';

export type PrototypeDatabase = PostgresJsDatabase<typeof schema>;
export type PrototypeAuthorityOptions = BetterAuthOptions & {
  plugins: [ReturnType<typeof oauthProvider>, ...BetterAuthPlugin[]];
};
export type PrototypeAuthority = Auth<PrototypeAuthorityOptions>;

async function readRevocationGeneration(database: PrototypeDatabase, userId: string): Promise<number> {
  const [cutoff] = await database
    .select({ generation: schema.prototypeUserCutoff.generation })
    .from(schema.prototypeUserCutoff)
    .where(eq(schema.prototypeUserCutoff.userId, userId));
  return cutoff?.generation ?? 0;
}

/** No production module imports this factory or mounts its handler. */
export function createPrototypeAuthority(
  database: PrototypeDatabase,
  overrides: BetterAuthOptions = {},
): PrototypeAuthority {
  const configuration: PrototypeAuthorityOptions = {
    ...PROTOTYPE_CONFIGURATION,
    ...overrides,
    advanced: { ...PROTOTYPE_CONFIGURATION.advanced, ...overrides.advanced },
    user: {
      ...PROTOTYPE_CONFIGURATION.user,
      ...overrides.user,
      additionalFields: { ...PROTOTYPE_CONFIGURATION.user.additionalFields, ...overrides.user?.additionalFields },
    },
    session: {
      ...PROTOTYPE_CONFIGURATION.session,
      ...overrides.session,
      additionalFields: { ...PROTOTYPE_CONFIGURATION.session.additionalFields, ...overrides.session?.additionalFields },
    },
    database: drizzleAdapter(database, { provider: 'pg', schema, transaction: true }),
    databaseHooks: {
      ...overrides.databaseHooks,
      session: {
        ...overrides.databaseHooks?.session,
        create: {
          ...overrides.databaseHooks?.session?.create,
          async before(session, context) {
            const prior = await overrides.databaseHooks?.session?.create?.before?.(session, context);
            if (prior === false) return false;
            const admitted = { ...session, ...(typeof prior === 'object' && prior !== null ? prior.data : {}) };
            // Only trusted authority creation stamps eligibility. Authentication
            // age remains createdAt; wall clocks never determine this binding.
            return {
              data: { ...admitted, revocationGeneration: await readRevocationGeneration(database, admitted.userId) },
            };
          },
          async after(session, context) {
            // Stock getSession trusts any stored row, and outside the global
            // advisory lock a reset can land between the stamp above and the
            // insert. The token has not left this request yet, so check again
            // now the row is committed: wait out any reset holding this user's
            // row (revokePrototypeUser), then read the generation it published.
            // Two statements on purpose: a single locking SELECT keeps the
            // snapshot it took before the wait and would still see the old value.
            await database
              .select({ id: schema.user.id })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId))
              .for('share');
            if (session.revocationGeneration !== (await readRevocationGeneration(database, session.userId))) {
              await database.delete(schema.session).where(eq(schema.session.id, session.id));
              throw new APIError('UNAUTHORIZED', {
                code: 'SESSION_REVOKED_DURING_CREATION',
                message: 'Session revoked during creation',
              });
            }
            await overrides.databaseHooks?.session?.create?.after?.(session, context);
          },
        },
      },
    },
    plugins: [oauthProvider(PROTOTYPE_OAUTH_OPTIONS), ...(overrides.plugins ?? [])],
  };
  return betterAuth(configuration);
}
