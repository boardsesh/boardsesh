import { betterAuth, type Auth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { oauthProvider } from '@better-auth/oauth-provider';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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
    plugins: [oauthProvider(PROTOTYPE_OAUTH_OPTIONS), ...(overrides.plugins ?? [])],
  };
  return betterAuth(configuration);
}
