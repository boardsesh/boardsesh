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
    return await readTesterRole(userId);
  } catch (error) {
    logger.error('[userIsTester] community_roles lookup failed; defaulting isTester=false', { userId, error });
    return false;
  }
}

/**
 * The same lookup, but a read failure THROWS instead of reading as "not a
 * tester".
 *
 * {@link userIsTester} fails soft because it decorates a profile: a transient
 * error there costs a tester their dev-tooling rows for one launch and nothing
 * more. This variant exists for the one caller where the answer is written down
 * — `qa_verdicts.by_tester`, which decides whether a verdict can ever move the
 * merge-gating label. Swallowing an error there stores a real tester's verdict
 * as a non-tester one permanently, with no signal and nothing to repair it
 * from. Failing the mutation instead lets the app retry, which costs one
 * re-tap.
 */
export async function readTesterRole(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: dbSchema.communityRoles.id })
    .from(dbSchema.communityRoles)
    .where(and(eq(dbSchema.communityRoles.userId, userId), inArray(dbSchema.communityRoles.role, [...TESTER_ROLES])))
    .limit(1);

  return row !== undefined;
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
