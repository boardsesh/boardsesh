/**
 * The three states a wall can be in on the web, from the board row alone.
 *
 * Pure and dependency-free on purpose: both the climb page and the wall's share
 * link redeem this rule, and the decision has to be reachable without pulling a
 * database client or a GraphQL document in behind it.
 *
 * What each state gets, and why, is written down where each page applies it —
 * `b/[board_slug]/[angle]/view/[climb_uuid]/spray-view.tsx` for a climb,
 * `b/[board_slug]/[angle]/list/spray-wall-view.tsx` for the wall.
 */

export type SprayWallVisibility = 'public' | 'unlisted' | 'private';

/**
 * Public wins over unlisted when a row carries both flags: the two are
 * independent booleans, the public copy of the photo already exists, the wall's
 * climbs are already announced to feeds, and treating it as unlisted would
 * withhold a card for a wall whose owner asked for the opposite. Same precedence
 * `sprayWallVisibility` applies in the app.
 */
export function resolveSprayWallVisibility(board: { isPublic: boolean; isUnlisted: boolean }): SprayWallVisibility {
  if (board.isPublic) return 'public';
  if (board.isUnlisted) return 'unlisted';
  return 'private';
}
