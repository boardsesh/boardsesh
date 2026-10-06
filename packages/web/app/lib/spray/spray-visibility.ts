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

/**
 * The share-link capability, as it appears in the query string.
 *
 * `buildSprayWallShareUrl` (`packages/mobile/src/lib/spray/spray-share.ts`) puts
 * `?wall=<uuid>` on every link to an unlisted wall. The uuid is unguessable, so
 * holding it is the proof somebody was given the link.
 */
export const WALL_CAPABILITY_PARAM = 'wall';

/**
 * The capability a request presents, or `undefined` when it presents none.
 *
 * Only a single string counts. A repeated param (`?wall=a&wall=b`) is not a
 * capability: picking one would let a link carry a spare uuid to try. A value
 * longer than any uuid is dropped before it reaches the backend.
 */
export function readWallCapability(wallParam: string | string[] | undefined): string | undefined {
  if (typeof wallParam !== 'string') return undefined;
  if (wallParam.length === 0 || wallParam.length > 64) return undefined;
  return wallParam;
}

export type SprayWallAccess = 'render' | 'refuse';

/**
 * Whether this request may see the wall, from the board row and the param alone.
 *
 * | The wall is | No `?wall=` | `?wall=` matches | `?wall=` is wrong |
 * | --- | --- | --- | --- |
 * | public | renders | renders | 404 |
 * | unlisted | 404 | renders | 404 |
 * | private | 404 | 404 | 404 |
 *
 * The backend applies the same rule before it hands the row over
 * (`boardBySlug(slug, wallUuid)`), so an anonymous request for an unlisted wall
 * without the right uuid never gets a row to decide on. This check is the second
 * lock, and it is the one that matters for a signed-in owner: `boardBySlug`
 * returns their own unlisted wall without a uuid, and www puts a shared
 * `s-maxage` on these paths with no session split, so rendering it on the bare
 * URL would put the wall in the CDN cache for anyone who asks.
 *
 * No round trip: a private wall is refused before anything asks the backend about
 * it, so the request never produces a signal that the wall exists.
 */
export function resolveSprayWallAccess(
  board: { uuid: string; isPublic: boolean; isUnlisted: boolean },
  wallParam: string | string[] | undefined,
): SprayWallAccess {
  const visibility = resolveSprayWallVisibility(board);
  if (visibility === 'private') return 'refuse';
  const capability = readWallCapability(wallParam);
  if (visibility === 'public') {
    // A public wall is world-readable, so a param is not needed — but a WRONG one
    // is still refused rather than ignored, because a link carrying somebody
    // else's uuid is a mistake worth surfacing as "not here" instead of quietly
    // showing a different wall than the sender meant.
    return wallParam === undefined || capability === board.uuid ? 'render' : 'refuse';
  }
  return capability === board.uuid ? 'render' : 'refuse';
}
