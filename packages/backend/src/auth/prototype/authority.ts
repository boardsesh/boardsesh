import { betterAuth, type Auth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
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
            const [cutoff] = await database
              .select({ generation: schema.prototypeUserCutoff.generation })
              .from(schema.prototypeUserCutoff)
              .where(eq(schema.prototypeUserCutoff.userId, admitted.userId));
            // Only trusted authority creation stamps eligibility. Authentication
            // age remains createdAt; wall clocks never determine this binding.
            return { data: { ...admitted, revocationGeneration: cutoff?.generation ?? 0 } };
          },
        },
      },
    },
    plugins: [oauthProvider(PROTOTYPE_OAUTH_OPTIONS), ...(overrides.plugins ?? [])],
  };
  return betterAuth(configuration);
}
