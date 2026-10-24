import { getBoardCapabilities } from '@boardsesh/board-config';
import type { ClimbSearchParams } from '../../../db/queries/climbs/index';

/**
 * The backend env var that lists the boards whose climb search may resolve stats
 * cross-angle when a client asks for it (issue #5412).
 *
 * `ClimbSearchInput.crossAngleStats: true` makes search rank and grade a climb by
 * the row at its own set angle when the browsed angle has none (#5405). On a big
 * catalogue that query cannot stop early: its sort key is a CASE over two joined
 * stats rows, which no index holds, so the whole layout is ranked before the page
 * is cut. Measured on production it costs ~0.9 s on MoonBoard layout 2 and ~5.6 s
 * on Kilter layout 1, against 1-7 ms without it. Until #5412 lands an index-ordered
 * shape, the only thing that kept it off was the mobile `cross-angle-stats` flag
 * sitting at 0% — and any client can send the field.
 *
 * Values:
 *   - unset or empty — no board honours the opt-in. This is the production default.
 *   - `*` — every board honours it, which is the behaviour before this gate.
 *   - a comma-separated list of board names, e.g. `moonboard,kilter`.
 *
 * Angle-bound boards (Woods) are not governed by this at all: there the opt-in is
 * the climber's own "Other angles" switch, and the catalogue is small enough that
 * the query is cheap (~120 ms on production).
 */
export const CROSS_ANGLE_STATS_BOARDS_ENV = 'CROSS_ANGLE_STATS_BOARDS';

/** Whether `rawSetting` (the env var's value) switches cross-angle stats on for this board. */
export function isCrossAngleStatsEnabledForBoard(boardName: string, rawSetting: string | undefined): boolean {
  if (!rawSetting) return false;
  const enabledBoards = rawSetting
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return enabledBoards.includes('*') || enabledBoards.includes(boardName.toLowerCase());
}

/**
 * Drops a client's cross-angle opt-in on a board the server has not switched on
 * for it, and returns the params unchanged otherwise.
 *
 * Applied once, in the `searchClimbs` resolver, to the params it hands to the
 * `ClimbSearchResult` field resolvers. The list, the count and the Redis cache key
 * all read that one object, so they cannot disagree about whether this search is
 * cross-angle.
 *
 * A dropped opt-in becomes `false`, not `undefined`: the app always sends an
 * explicit boolean, so a gated search then shares its cache entry with the
 * ordinary search it now is.
 *
 * Only `true` can change anything: `resolveCrossAngleStats` in
 * packages/db/src/queries/climbs/effective-stats.ts treats every other value as
 * off, and a by-name search on an angle-bound board goes cross-angle by itself,
 * which this does not touch.
 */
export function gateCrossAngleStats(
  boardName: string,
  searchParams: ClimbSearchParams,
  rawSetting: string | undefined = process.env[CROSS_ANGLE_STATS_BOARDS_ENV],
): ClimbSearchParams {
  if (searchParams.crossAngleStats !== true) return searchParams;
  if (getBoardCapabilities(boardName).angleBoundClimbs) return searchParams;
  if (isCrossAngleStatsEnabledForBoard(boardName, rawSetting)) return searchParams;
  return { ...searchParams, crossAngleStats: false };
}
