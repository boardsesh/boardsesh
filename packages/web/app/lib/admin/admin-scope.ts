/**
 * Role-scope predicates for the /admin subtree.
 *
 * A `community_roles` row with a null `board_type` is a global assignment; a
 * non-null one only covers that board type. Every resolver behind /admin —
 * `communityRoles`, `grantRole`, `revokeRole`, `setCommunitySettings`,
 * `pendingGymClaims`, `reviewGymClaim`, `duplicateGymClusters`, `mergeGyms`,
 * `adminAppFeedback`, `updateAppFeedbackStatus` — calls `requireAdmin(ctx)` /
 * `requireAdminOrLeader(ctx)` with no board type, and those only accept a
 * globally-scoped admin. So "global admin" is the bar for these pages: a
 * board-scoped admin who gets in only sees a page whose every action fails.
 *
 * Deliberately free of `server-only` so both the server pages and the client
 * hub can share one predicate.
 */
export type AdminRoleScope = { role: string; boardType?: string | null };

/** Does this user hold an `admin` role that applies to every board type? */
export function rolesGrantGlobalAdmin(roles: AdminRoleScope[]): boolean {
  return roles.some((entry) => entry.role === 'admin' && entry.boardType == null);
}

/** Does this user hold an `admin` role limited to a single board type? */
export function rolesGrantScopedAdmin(roles: AdminRoleScope[]): boolean {
  return roles.some((entry) => entry.role === 'admin' && entry.boardType != null);
}
