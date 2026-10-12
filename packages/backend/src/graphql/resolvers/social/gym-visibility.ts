import { and, eq, exists, inArray, isNotNull, isNull, or, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';

// Predicate construction must not depend on a database connection or its mocks.
const queryBuilder = new QueryBuilder();

/** Gym member roles that may edit a gym, and so see it while it is private. */
const GYM_EDITOR_MEMBER_ROLES = ['admin', 'editor'] as const;

/** Community roles with moderation reach (`rolesGrantAdminOrLeader`). */
const GYM_MODERATOR_COMMUNITY_ROLES = ['admin', 'community_leader'] as const;

/**
 * Whether this viewer may see the gym at all, as SQL. A public gym is visible
 * to everyone, signed in or not. A private gym is visible only to the people
 * `userCanEditGym` admits, the same rule `gym`, `gymBySlug`, `gymBoards` and
 * `gymKiosk` use to hide it from everyone else (`resolveViewableGym`):
 *
 * - its owner;
 * - a gym member with the `admin` or `editor` role (a plain `member` does not
 *   see a private gym);
 * - a community admin or leader whose role is global, or scoped to the board
 *   type of a live board linked to the gym (`hasGymCommunityAccess`).
 *
 * Liveness is the caller's: this checks visibility only, not `deleted_at`.
 *
 * Every subquery names the viewer and never the gym row, so PostgreSQL runs
 * each once per statement (an InitPlan, or a hashed set the gym id is probed
 * against) rather than once per gym. This sits inside the privacy predicate of
 * every inbox and feed read; correlated subqueries here raised the inbox's
 * estimated cost past `jit_above_cost`, and JIT compilation then took 2.5 s.
 *
 * `privacy-private-gym-comments.test.ts` runs one matrix through this condition,
 * `userCanEditGym` and the `gym` resolver, so the two rules cannot drift.
 */
export function gymVisibleCondition(
  gym: { id: SQLWrapper; ownerId: SQLWrapper; isPublic: SQLWrapper },
  viewerId: string | null | undefined,
): SQL {
  if (!viewerId) return eq(gym.isPublic, true);
  const member = alias(dbSchema.gymMembers, 'gym_visibility_member');
  const role = alias(dbSchema.communityRoles, 'gym_visibility_role');
  const board = alias(dbSchema.userBoards, 'gym_visibility_board');
  const moderatorRole = and(eq(role.userId, viewerId), inArray(role.role, [...GYM_MODERATOR_COMMUNITY_ROLES]));
  return or(
    eq(gym.isPublic, true),
    eq(gym.ownerId, viewerId),
    inArray(
      gym.id,
      queryBuilder
        .select({ gymId: member.gymId })
        .from(member)
        .where(and(eq(member.userId, viewerId), inArray(member.role, [...GYM_EDITOR_MEMBER_ROLES]))),
    ),
    // A global role covers every gym.
    exists(
      queryBuilder
        .select({ id: role.id })
        .from(role)
        .where(and(moderatorRole, isNull(role.boardType))),
    ),
    // A board-scoped role covers the gyms with a live board of that type.
    inArray(
      gym.id,
      queryBuilder
        .select({ gymId: board.gymId })
        .from(board)
        .innerJoin(role, eq(role.boardType, board.boardType))
        .where(and(moderatorRole, isNotNull(board.gymId), isNull(board.deletedAt))),
    ),
  )!;
}
