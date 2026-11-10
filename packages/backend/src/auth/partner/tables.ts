import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  oauthSession,
  oauthVerification,
  users,
} from '@boardsesh/db/schema/auth';

/**
 * The tables the Better Auth Drizzle adapter addresses, under the export names
 * it looks them up by. `user`, `session` and `verification` map to `users`,
 * `oauthSession` and `oauthVerification`. `account` is deliberately absent: the
 * authority never reads or writes it.
 */
export const partnerAdapterSchema = {
  users,
  oauthSession,
  oauthVerification,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
} as const;

export type PartnerDatabase = PostgresJsDatabase<typeof partnerAdapterSchema>;
