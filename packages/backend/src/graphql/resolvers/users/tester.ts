import { and, eq, inArray } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated } from '../shared/helpers';
import { logger } from '../../../utils/logger';
import { TESTER_ROLES } from './role-flags';

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

/**
 * Gate for the tester-only operations (crowdsourced QA). Unlike
 * {@link userIsTester} — a cosmetic flag that fails closed silently — this is
 * an authorization check, so it throws. Mirrors `requireAdmin`.
 */
export async function requireTester(ctx: ConnectionContext): Promise<void> {
  requireAuthenticated(ctx);

  if (!(await userIsTester(ctx.userId!))) {
    throw new Error('Tester role required for this operation');
  }
}
