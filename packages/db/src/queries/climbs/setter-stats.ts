import { isSizeScopedBoard } from '@boardsesh/board-config';
import { and, eq, ilike, sql } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { boardClimbs, boardClimbStats } from '../../schema/index';
import { withSerialPlan } from '../util/serial-plan';
import type { BoardRouteParams, ClimbSearchParams } from './types';
import { followedAuthorCondition } from './followed-authors';
import { browsedAngleRestrictionSql, resolveBrowsedAngleRestriction } from './effective-stats';

/**
 * One row in the setter-stats result: a setter's username and how many
 * climbs they've authored on the given board/layout/size. Returned by
 * `getSetterStats` and consumed by the search drawer's setter filter
 * autocomplete on both web and mobile.
 */
export type SetterStat = {
  setter_username: string;
  climb_count: number;
};

/**
 * The one search input the setter aggregate reads besides the board. Picked from
 * `ClimbSearchParams` rather than redeclared, so the picker's opt-in cannot drift
 * from the list's: it is the same field, with the same "omitted means off".
 */
export type SetterStatsOptions = Pick<ClimbSearchParams, 'crossAngleStats'>;

/**
 * Aggregate setter usernames with their climb counts for a board configuration.
 *
 * Membership follows the climb list's angle rule, and that rule depends on the
 * board.
 *
 * On a catalogue board (every board but Woods) list membership is
 * angle-independent — `countClimbs` and `runStandardSearch` both LEFT JOIN
 * `board_climb_stats`, so the angle decides a climb's grade and its sort position,
 * never whether it exists — and so is this query: `params.angle` is ignored and
 * nothing joins `board_climb_stats`. It used to INNER JOIN stats at the angle,
 * which meant a setter only appeared if one of their climbs happened to carry a
 * stats row at exactly the board's current tilt (#5404).
 *
 * Woods is the board that proved it. Every Woods climb has exactly one stats row,
 * at the angle it was set at (Aurora boards replicate stats across angles; Woods
 * does not), so the join reduced woods/layout 1/size 1 from 15 setters to 3 and
 * hid the board's most prolific setter — 246 climbs, none of them at 25°.
 *
 * Woods is also where angle-blind stopped being the list's answer. Its climbs are
 * angle-bound (`getBoardCapabilities(board).angleBoundClimbs`), and since #5642 a
 * Woods list keeps only the climbs for the browsed angle unless the search opts in
 * with `crossAngleStats` (the "Other angles" switch). An angle-blind count then
 * offered that same setter as "246 climbs" at 25°, and picking them gave an empty
 * list. So on an angle-bound board without `options.crossAngleStats`, this applies
 * the list's own predicate, `browsedAngleRestrictionSql` — set at the browsed
 * angle, no set angle recorded, or a stats row there — decided by the list's own
 * `resolveBrowsedAngleRestriction`. That is not the #5404 join coming back: the
 * restriction admits a climb through any one of its three arms, and the stats row
 * its third arm probes comes from a LEFT JOIN on the stats primary key
 * (board_type, climb_uuid, angle), so it can neither drop a climb the list shows
 * nor match two rows for one climb and inflate a count. With the opt-in the Woods
 * count is angle-blind again, matching the opted-in list. Every unrestricted call
 * renders exactly the join-free SQL it did before #5642.
 *
 * No climb name reaches the resolver. `searchQuery` narrows `setter_username`,
 * not the climb name, so the by-name exception that makes a Woods list cross-angle
 * on its own never fires here: the climb-name filter is one of the drawer's other
 * filters the counts come before (next paragraph), and a caller that wants every
 * angle says so with `crossAngleStats`.
 *
 * The counts mean the climbs this filter can surface at this board configuration,
 * before the drawer's other filters. Notably NOT mirrored from `createClimbFilters`
 * is the boulders/routes `frames_count` condition: both clients default to
 * boulders-only, so a setter's count can include multi-frame routes the default list
 * omits. Mirroring it would mean plumbing a search param into SetterStatsInput.
 *
 * Every other predicate tracks `baseConditions` in create-climb-filters.ts, so the
 * picker and the list agree on the universe:
 *
 * - `is_listed` / `is_draft` — previously enforced only as a side effect of the
 *   stats join (drafts have no stats rows). They have to be explicit now. This is
 *   load-bearing on MoonBoard rather than cosmetic: the size predicate below is
 *   skipped for MoonBoard, so nothing else would keep other people's drafts out of
 *   the picker. `is_listed` is nullable and `= true` drops NULLs, matching the list.
 * - `required_set_ids` — the sets this board is fitted with. MoonBoard (and freshly
 *   saved drafts) can leave the column NULL while it backfills, so MoonBoard allows
 *   NULL through, the same escape `setIdsConditions` makes.
 * - Community-hidden climbs are excluded (#5049). Unlike the list's
 *   `hiddenClimbCondition`, there is no name-search exception here — this query's
 *   `searchQuery` filters `setter_username`, not the climb name.
 * - The browsed-angle restriction described above, which the list carries in
 *   `browsedAngleConditions`. The list's one exemption from it — a user's own
 *   drafts list — cannot arise here, because `is_draft = false` keeps every
 *   draft out of the picker.
 *
 * Size-scoped boards (everything but MoonBoard) are filtered to climbs whose
 * `compatible_size_ids` contains the requested size, using array containment
 * (`@>`) so Postgres can use the `board_climbs_compatible_size_ids_idx` GIN
 * index. MoonBoard has a single fixed product size and never populates
 * `compatible_size_ids`, so the size predicate is skipped entirely for it —
 * `size_id = ANY(NULL)` evaluates to NULL and would otherwise drop every
 * MoonBoard row (#4008).
 *
 * Capped at 50 rows ordered by descending climb count, with a username tiebreaker
 * so the cut is deterministic — the long tail is dominated by one-climb setters,
 * and an unordered tie at row 50 would make the picker flicker between refetches.
 *
 * Runs under `withSerialPlan`: a scan of the whole layout in `board_climbs` feeding
 * a HashAggregate is a plan the planner is happy to parallelize, and the per-worker
 * DSM allocations are what kept exhausting `/dev/shm` (#4105). The LIMIT 50 applies
 * after the GROUP BY, so it does not bound the scan. The restricted Woods shape
 * adds one primary-key LEFT JOIN per climb to the same scan, which leaves the
 * guard exactly as necessary and the LIMIT exactly where it was.
 */
export const getSetterStats = async (
  db: DbInstance,
  params: BoardRouteParams,
  searchQuery?: string,
  followingUserId?: string,
  options: SetterStatsOptions = {},
): Promise<SetterStat[]> => {
  // No `name`: `searchQuery` is a setter-username filter, never a climb-name
  // search, so it must not trigger the by-name cross-angle exception. False on
  // every board that is not angle-bound, and then nothing below changes.
  const restrictToBrowsedAngle = resolveBrowsedAngleRestriction(params, {
    crossAngleStats: options.crossAngleStats,
  });

  // MoonBoard leaves required_set_ids NULL until the backfill runs; better to offer
  // a setter than to hide one. Mirrors `allowNullRequiredSets` in create-climb-filters.
  const allowNullRequiredSets = params.board_name === 'moonboard';

  const whereConditions = [
    ...(followingUserId !== undefined ? [followedAuthorCondition(followingUserId)] : []),
    eq(boardClimbs.boardType, params.board_name),
    eq(boardClimbs.layoutId, params.layout_id),
    eq(boardClimbs.isListed, true),
    eq(boardClimbs.isDraft, false),
    ...(isSizeScopedBoard(params.board_name)
      ? [sql`${boardClimbs.compatibleSizeIds} @> ARRAY[${params.size_id}]::int[]`]
      : []),
    ...(params.set_ids.length > 0
      ? [
          allowNullRequiredSets
            ? sql`(${boardClimbs.requiredSetIds} IS NULL OR ${boardClimbs.requiredSetIds} <@ ARRAY[${sql.join(
                params.set_ids.map((id) => sql`${id}`),
                sql`, `,
              )}]::int[])`
            : sql`${boardClimbs.requiredSetIds} <@ ARRAY[${sql.join(
                params.set_ids.map((id) => sql`${id}`),
                sql`, `,
              )}]::int[]`,
        ]
      : []),
    sql`${boardClimbs.setterUsername} IS NOT NULL`,
    sql`${boardClimbs.setterUsername} != ''`,
    // A climb the community hid is off the wall as far as browsing goes, so it
    // must not pad its setter's count either — the autocomplete would otherwise
    // promise climbs the search below it can never return.
    eq(boardClimbs.isHidden, false),
    // Woods without the opt-in: count only the climbs the list shows at this
    // angle (#5642). The predicate's stats arm reads the unaliased
    // `board_climb_stats`, which only the restricted shape below joins.
    ...(restrictToBrowsedAngle ? [browsedAngleRestrictionSql(params.angle)] : []),
  ];

  if (searchQuery && searchQuery.trim().length > 0) {
    whereConditions.push(ilike(boardClimbs.setterUsername, `%${searchQuery}%`));
  }

  const result = await withSerialPlan(db, (tx) => {
    const fromClimbs = tx
      .select({
        setter_username: boardClimbs.setterUsername,
        climb_count: sql<number>`count(*)::int`,
      })
      .from(boardClimbs);
    // The browsed-angle stats row, joined only when the restriction needs its
    // presence probe, so an unrestricted call renders the same join-free SQL it
    // always did. Same ON as the list's `getClimbStatsJoinConditions`; the three
    // columns are the stats primary key, so at most one row joins per climb and
    // count(*) still counts climbs.
    const withBrowsedAngleStats = restrictToBrowsedAngle
      ? fromClimbs.leftJoin(
          boardClimbStats,
          and(
            eq(boardClimbStats.climbUuid, boardClimbs.uuid),
            eq(boardClimbStats.boardType, params.board_name),
            eq(boardClimbStats.angle, params.angle),
          ),
        )
      : fromClimbs;
    return withBrowsedAngleStats
      .where(and(...whereConditions))
      .groupBy(boardClimbs.setterUsername)
      .orderBy(sql`count(*) DESC`, sql`${boardClimbs.setterUsername} ASC`)
      .limit(50);
  });

  // Strip any nulls — they're filtered out in the WHERE clause but the
  // column is nullable in the schema so TS doesn't know that.
  return result.filter((stat): stat is SetterStat => stat.setter_username !== null);
};
