/**
 * Community role authorization, as pure functions over role rows.
 *
 * The backend stores one row per grant in `community_roles` — a role name plus
 * a board-type scope. Both the GraphQL resolvers and the clients need the same
 * verdict from those rows (may this user moderate here? how heavily does their
 * vote count?), so the rules live here rather than being re-implemented per
 * surface. Everything is synchronous and side-effect free: fetch the rows once,
 * then answer as many board types as you like in memory.
 *
 * ## The scoping rule
 *
 * A role row is either **global** or **board-scoped**:
 *
 * - `boardType === null` — a global grant. It applies to every board type, and
 *   also to a check that names no board type at all.
 * - `boardType === 'kilter'` (any string) — a board-scoped grant. It applies
 *   only when the check asks about that exact board type. A board-scoped role
 *   grants nothing to a check that omits `boardType`, because an unscoped check
 *   is asking about authority everywhere, which a single board doesn't confer.
 *
 * Only `admin` and `community_leader` carry authority. Every other role name
 * (`tester`, and anything added later) is inert here: it grants no access and
 * leaves the vote weight at the default.
 */

/**
 * A community role row reduced to what authorization needs: the role name and
 * its board-type scope (`null` = global, applies to every board type).
 */
export type CommunityRoleScope = { role: string; boardType: string | null };

/** Vote weight for a user holding an in-scope `admin` role. */
export const ADMIN_VOTE_WEIGHT = 3;

/** Vote weight for a user holding an in-scope `community_leader` role. */
export const LEADER_VOTE_WEIGHT = 2;

/** Vote weight for everyone else, including users with no roles at all. */
export const DEFAULT_VOTE_WEIGHT = 1;

const ADMIN_ROLE = 'admin';
const COMMUNITY_LEADER_ROLE = 'community_leader';

/**
 * Is this role row in scope for the given board type?
 *
 * Global rows (`boardType === null`) are always in scope. A board-scoped row is
 * in scope only when its board type matches exactly — so a `kilter`-scoped row
 * is out of scope both for `tension` and for a check that passes no board type.
 */
export function roleAppliesToBoard(role: CommunityRoleScope, boardType?: string | null): boolean {
  return role.boardType === null || role.boardType === boardType;
}

/**
 * Do these role rows grant admin access for the given board type?
 *
 * True when at least one row is `admin` and in scope. Use this for actions only
 * admins may take; `rolesGrantAdminOrLeader` is the wider moderation check.
 */
export function rolesGrantAdmin(roles: readonly CommunityRoleScope[], boardType?: string | null): boolean {
  return roles.some((entry) => entry.role === ADMIN_ROLE && roleAppliesToBoard(entry, boardType));
}

/**
 * Do these role rows grant admin **or** community-leader access for the given
 * board type?
 *
 * This is the moderation gate — editing community content, resolving reports —
 * where a community leader has the same reach as an admin.
 */
export function rolesGrantAdminOrLeader(roles: readonly CommunityRoleScope[], boardType?: string | null): boolean {
  return roles.some(
    (entry) =>
      (entry.role === ADMIN_ROLE || entry.role === COMMUNITY_LEADER_ROLE) && roleAppliesToBoard(entry, boardType),
  );
}

/**
 * How heavily does this user's vote count on the given board type?
 *
 * The strongest in-scope role wins: {@link ADMIN_VOTE_WEIGHT} for an admin,
 * {@link LEADER_VOTE_WEIGHT} for a community leader, and
 * {@link DEFAULT_VOTE_WEIGHT} as the floor — a user with no roles, only
 * out-of-scope roles, or only inert roles such as `tester` still gets one vote.
 */
export function voteWeightForRoles(roles: readonly CommunityRoleScope[], boardType?: string | null): number {
  let maxWeight: number = DEFAULT_VOTE_WEIGHT;

  for (const entry of roles) {
    if (!roleAppliesToBoard(entry, boardType)) continue;
    if (entry.role === ADMIN_ROLE) maxWeight = Math.max(maxWeight, ADMIN_VOTE_WEIGHT);
    if (entry.role === COMMUNITY_LEADER_ROLE) maxWeight = Math.max(maxWeight, LEADER_VOTE_WEIGHT);
  }

  return maxWeight;
}
