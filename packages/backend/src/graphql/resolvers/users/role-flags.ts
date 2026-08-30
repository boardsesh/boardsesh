import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';

/**
 * The two community-role flags `UserProfile` carries, resolved from ONE read.
 *
 * Both ride inside the core `profile` query — the single most-requested query in
 * the app — so they are answered together rather than with a query each. The
 * rules differ but the rows do not, and a serialized second round trip to the
 * same table for the same user is latency nobody gets anything for.
 */

/** A `community_roles` row reduced to what these flags read. */
export type CommunityRoleRow = { role: string; boardType: string | null };

/**
 * Roles that unlock the tester-only developer tooling in the mobile app. Admins
 * implicitly count as testers so they always have access.
 */
export const TESTER_ROLES = ['tester', 'admin'] as const;

/** Pure: do these role rows unlock the tester-only developer tooling? */
export function rolesGrantTester(roles: readonly CommunityRoleRow[]): boolean {
  return roles.some((entry) => (TESTER_ROLES as readonly string[]).includes(entry.role));
}

/**
 * Pure: do these role rows make the account an admin of ANYTHING?
 *
 * Board scope is deliberately ignored. The flag decides whether an admin entry
 * point is worth showing at all; every admin-only operation re-checks the scope
 * server-side with `requireAdmin(ctx, boardName)`, so a board-scoped admin who
 * opens the tooling for someone else's board is refused there rather than hidden
 * from it here. That is also why this is not `hasAdmin` from social/roles —
 * called with no board type that keeps only the global rows, which is the right
 * rule for an authorization gate and the wrong one for "is this account an admin
 * of anything".
 */
export function rolesGrantAdmin(roles: readonly CommunityRoleRow[]): boolean {
  return roles.some((entry) => entry.role === 'admin');
}

/**
 * `isTester` and `isAdmin` for one account, from a single `community_roles` read.
 *
 * Fail-closed. This runs inside the core `profile` query, so a transient role
 * table error must NOT fail the whole profile load — that would break the You
 * tab for every signed-in user. On error we log and report both flags false:
 * worst case a tester or admin briefly doesn't see their tooling, never a broken
 * profile.
 */
export async function loadProfileRoleFlags(userId: string): Promise<{ isTester: boolean; isAdmin: boolean }> {
  try {
    const roles = await db
      .select({ role: dbSchema.communityRoles.role, boardType: dbSchema.communityRoles.boardType })
      .from(dbSchema.communityRoles)
      .where(eq(dbSchema.communityRoles.userId, userId));

    return { isTester: rolesGrantTester(roles), isAdmin: rolesGrantAdmin(roles) };
  } catch (error) {
    logger.error('[loadProfileRoleFlags] community_roles lookup failed; defaulting both flags to false', {
      userId,
      error,
    });
    return { isTester: false, isAdmin: false };
  }
}
