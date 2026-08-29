import { and, eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';

/**
 * Whether a user holds an admin community role at all — global or scoped to one
 * board. Drives `UserProfile.isAdmin`, which is what the client uses to decide
 * whether to show admin-only tooling (the hold-outline editor first).
 *
 * A board-scoped admin answers true here even though their reach is one board.
 * The flag decides whether the entry point is worth showing; every admin-only
 * operation re-checks the scope server-side with `requireAdmin(ctx, boardName)`,
 * so a scoped admin who opens the tooling for someone else's board is refused
 * there rather than hidden from it here. That is also why this does not call
 * `hasAdmin` from social/roles: called with no board type it keeps only the
 * global rows, which is the right rule for an authorization gate and the wrong
 * one for "is this account an admin of anything".
 *
 * Fail-closed, for the same reason as {@link userIsTester}: this rides inside
 * the core `profile` query, so a transient `community_roles` read error must not
 * break the You tab for every signed-in user. Worst case an admin briefly
 * doesn't see the tooling.
 */
export async function userIsAdmin(userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: dbSchema.communityRoles.id })
      .from(dbSchema.communityRoles)
      .where(and(eq(dbSchema.communityRoles.userId, userId), eq(dbSchema.communityRoles.role, 'admin')))
      .limit(1);

    return row !== undefined;
  } catch (error) {
    logger.error('[userIsAdmin] community_roles lookup failed; defaulting isAdmin=false', { userId, error });
    return false;
  }
}
