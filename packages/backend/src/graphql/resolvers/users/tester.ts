import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { logger } from '../../../utils/logger';

// Roles that unlock the tester-only developer tooling in the mobile app.
// Admins implicitly count as testers so they always have access.
const TESTER_ROLES = ['tester', 'admin'] as const;

/**
 * Whether a user can reach the tester-only developer tooling — true when they
 * hold a global or board-scoped `tester` (or `admin`) row in `community_roles`.
 * Drives `UserProfile.isTester`.
 *
 * Fail-closed: this is a cosmetic dev-tooling flag riding inside the core
 * `profile` query, so a transient `community_roles` read error must NOT fail the
 * whole profile load (which would break the You tab for every signed-in user).
 * On error we log and return false — worst case a tester briefly doesn't see the
 * tooling, never a broken profile.
 */
export async function userIsTester(userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: dbSchema.communityRoles.id })
      .from(dbSchema.communityRoles)
      .where(and(eq(dbSchema.communityRoles.userId, userId), inArray(dbSchema.communityRoles.role, [...TESTER_ROLES])))
      .limit(1);

    return row !== undefined;
  } catch (error) {
    logger.error('[userIsTester] community_roles lookup failed; defaulting isTester=false', { userId, error });
    return false;
  }
}
