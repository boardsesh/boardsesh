import { sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { UserProfile } from '@boardsesh/shared-schema';
import { FAVORITE_COUNT_SUBQUERY } from './favorite-count';
import { userIsTester } from './tester';

// Correlated subqueries for the two account-shape fields on UserProfile.
// Same reasoning as FAVORITE_COUNT_SUBQUERY: the `profile` query and the
// `updateProfile` mutation both need them and both must stay a single round
// trip (issue #3603). The REST route these replaced ran them as two extra
// parallel queries against user_credentials and accounts.
//
// Raw sql() rather than the query builder: both are "aggregate from another
// table per user row", which a join can't express here without a GROUP BY
// that would force restructuring the callers' single-row selects.

/** True when the account has an email + password credential (a user_credentials row). */
export const HAS_PASSWORD_SUBQUERY = sql<boolean>`(select exists (select 1 from ${dbSchema.userCredentials} where ${dbSchema.userCredentials.userId} = ${dbSchema.users.id}))`;

/** Every OAuth provider linked to the account, or an empty array when there are none. */
export const LINKED_PROVIDERS_SUBQUERY = sql<
  string[]
>`(select coalesce(array_agg(${dbSchema.accounts.provider}), '{}') from ${dbSchema.accounts} where ${dbSchema.accounts.userId} = ${dbSchema.users.id})`;

/**
 * The single select shape behind both `Query.profile` and
 * `Mutation.updateProfile`, so the two can never drift apart on which fields
 * a UserProfile carries. Meant to be spread into `.select({ ...PROFILE_SELECT })`
 * followed by a leftJoin on user_profiles.
 */
export const PROFILE_SELECT = {
  id: dbSchema.users.id,
  email: dbSchema.users.email,
  name: dbSchema.users.name,
  image: dbSchema.users.image,
  createdAt: dbSchema.users.createdAt,
  displayName: dbSchema.userProfiles.displayName,
  avatarUrl: dbSchema.userProfiles.avatarUrl,
  instagramUrl: dbSchema.userProfiles.instagramUrl,
  hasPassword: HAS_PASSWORD_SUBQUERY,
  linkedProviders: LINKED_PROVIDERS_SUBQUERY,
  favoriteCount: FAVORITE_COUNT_SUBQUERY,
} as const;

export type ProfileRow = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  createdAt: Date;
  displayName: string | null;
  avatarUrl: string | null;
  instagramUrl: string | null;
  hasPassword: boolean;
  linkedProviders: string[] | null;
  favoriteCount: number;
};

/**
 * Map a PROFILE_SELECT row onto the GraphQL UserProfile. displayName/avatarUrl
 * fall back to the NextAuth-derived users.name / users.image, matching what
 * `publicProfile` already does, so a user who never opened the settings form
 * still renders with their OAuth name and picture.
 */
export async function mapProfileRow(row: ProfileRow): Promise<UserProfile> {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName || row.name || undefined,
    avatarUrl: row.avatarUrl || row.image || undefined,
    instagramUrl: row.instagramUrl || undefined,
    hasPassword: row.hasPassword ?? false,
    linkedProviders: row.linkedProviders ?? [],
    isTester: await userIsTester(row.id),
    createdAt: row.createdAt.toISOString(),
    favoriteCount: row.favoriteCount,
  };
}
