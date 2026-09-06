import { isSizeScopedBoard } from '@boardsesh/board-config';
import { and, eq, ilike, sql } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { boardClimbs, boardClimbStats } from '../../schema/index';
import { withSerialPlan } from '../util/serial-plan';
import type { BoardRouteParams } from './types';

/**
 * One row in the setter-stats result: a setter's username and how many
 * climbs they've authored on the given board/layout/angle. Returned by
 * `getSetterStats` and consumed by the search drawer's setter filter
 * autocomplete on both web and mobile.
 */
export type SetterStat = {
  setter_username: string;
  climb_count: number;
};

/**
 * Aggregate setter usernames with their climb counts for a board configuration.
 *
 * Joins `board_climbs` with `board_climb_stats` so we only count climbs that
 * actually exist at the requested angle (the inner join drops setters whose
 * climbs have no stats row at the angle). An optional `searchQuery` filters
 * setter usernames with a case-insensitive substring match for autocomplete.
 *
 * Capped at 50 rows ordered by descending climb count for UI performance.
 *
 * Community-hidden climbs are excluded, matching `searchClimbs`: the count next
 * to a setter's name has to mean the climbs the filter will actually surface.
 *
 * Size-scoped boards (everything but MoonBoard) are filtered to climbs whose
 * `compatible_size_ids` contains the requested size, using array containment
 * (`@>`) so Postgres can use the `board_climbs_compatible_size_ids_idx` GIN
 * index. MoonBoard has a single fixed product size and never populates
 * `compatible_size_ids`, so the size predicate is skipped entirely for it —
 * `size_id = ANY(NULL)` evaluates to NULL and would otherwise drop every
 * MoonBoard row. This is deliberately board-type-gated rather than
 * NULL-tolerant: Kilter draft climbs can also have a NULL
 * `compatible_size_ids` (see the "Draft climbs may have NULL
 * compatible_size_ids" comments in search-climbs.ts) and must stay excluded.
 *
 * Runs under `withSerialPlan`: this hash-joins the two biggest catalog tables
 * over a whole layout and aggregates them, which the planner is happy to run as
 * a parallel hash join. It fires from the same search drawer as `searchClimbs`
 * on the same table pair, so it kept exhausting `/dev/shm` after #3856 guarded
 * the search paths themselves (#4105). The LIMIT 50 applies after the GROUP BY,
 * so it does not bound the scan.
 */
export const getSetterStats = async (
  db: DbInstance,
  params: BoardRouteParams,
  searchQuery?: string,
): Promise<SetterStat[]> => {
  const whereConditions = [
    eq(boardClimbs.boardType, params.board_name),
    eq(boardClimbs.layoutId, params.layout_id),
    eq(boardClimbStats.angle, params.angle),
    ...(isSizeScopedBoard(params.board_name)
      ? [sql`${boardClimbs.compatibleSizeIds} @> ARRAY[${params.size_id}]::int[]`]
      : []),
    sql`${boardClimbs.setterUsername} IS NOT NULL`,
    sql`${boardClimbs.setterUsername} != ''`,
    // A climb the community hid is off the wall as far as browsing goes, so it
    // must not pad its setter's count either — the autocomplete would otherwise
    // promise climbs the search below it can never return.
    eq(boardClimbs.isHidden, false),
  ];

  if (searchQuery && searchQuery.trim().length > 0) {
    whereConditions.push(ilike(boardClimbs.setterUsername, `%${searchQuery}%`));
  }

  const result = await withSerialPlan(db, (tx) =>
    tx
      .select({
        setter_username: boardClimbs.setterUsername,
        climb_count: sql<number>`count(*)::int`,
      })
      .from(boardClimbs)
      .innerJoin(
        boardClimbStats,
        and(eq(boardClimbStats.climbUuid, boardClimbs.uuid), eq(boardClimbStats.boardType, params.board_name)),
      )
      .where(and(...whereConditions))
      .groupBy(boardClimbs.setterUsername)
      .orderBy(sql`count(*) DESC`)
      .limit(50),
  );

  // Strip any nulls — they're filtered out in the WHERE clause but the
  // column is nullable in the schema so TS doesn't know that.
  return result.filter((stat): stat is SetterStat => stat.setter_username !== null);
};
