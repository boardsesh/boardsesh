import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PROTOTYPE_CONFIGURATION } from './configuration';
import { PROTOTYPE_OAUTH_OPTIONS } from './oauth-options';
import type { PrototypeAuthority, PrototypeAuthorityOptions } from './authority';

// Better Auth initializes plugins eagerly, including the OAuth resource seed.
// The schema generator must never create a client or seed a real database.
// Actual compatibility tests use environment.ts and real Postgres instead.
const generatorDatabase = drizzle.mock();

const configuration: PrototypeAuthorityOptions = {
  ...PROTOTYPE_CONFIGURATION,
  database: drizzleAdapter(generatorDatabase, { provider: 'pg', transaction: true }),
  plugins: [oauthProvider({ ...PROTOTYPE_OAUTH_OPTIONS, resources: [] })],
};
export const auth: PrototypeAuthority = betterAuth(configuration);
