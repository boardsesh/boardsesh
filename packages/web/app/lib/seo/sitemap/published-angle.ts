import 'server-only';
import { ANGLES } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * The ONE rule that decides which angle a climb's canonical URL is built at.
 *
 * The angle is a path segment (`/{board}/{layout}/{size}/{sets}/{angle}/view/…`),
 * so two builders that pick different angles for the same climb publish two
 * URLs for one page. That is the wrong-board-URL bug this campaign has now hit
 * five times, and it used to live here as two hand-written `ORDER BY`s: the
 * climbs sitemap carried the `COALESCE` tie-break and the in-range guard, the
 * setter front door carried neither. Measured on the dev image, 28 tier-2
 * climbs were linked at an angle the sitemap never submitted.
 *
 * Both callers now build the ordering from this file, so the two cannot drift
 * without the byte-comparison in `server-setter-data.test.ts` going red.
 */

/**
 * The angles the route tables carry for a board. Anything outside this list has
 * no page — that URL 404s — so it must never win the pick.
 */
export function publishableAngles(boardName: BoardName): number[] {
  return [...ANGLES[boardName]];
}

function intArrayLiteral(values: readonly number[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::int[]`;
}

/**
 * `publishableAngles`, as a predicate over a column whose board is only known
 * per row.
 *
 * The climbs sitemap runs one query per `(board_type, layout_id)` group and can
 * therefore use a plain `inArray(angle, publishableAngles(boardName))`. The
 * setter front door lists one setter's climbs across every board they have set
 * on, so the allowed angles change row by row and the guard has to be a `CASE`
 * over the row's own `board_type`. Same list, same source, two shapes.
 *
 * An unknown `board_type` yields the empty array, so it selects no angle at all
 * rather than silently accepting every angle in the stats table.
 */
export function publishableAngleWhere(statsAngle: SQLWrapper, boardType: SQLWrapper): SQL {
  const branches = (Object.keys(ANGLES) as BoardName[]).map(
    (boardName) => sql`when ${boardName} then ${intArrayLiteral(publishableAngles(boardName))}`,
  );

  return sql`${statsAngle} = any(case ${boardType} ${sql.join(branches, sql` `)} else ARRAY[]::int[] end)`;
}

export type PublishedAngleColumns = {
  /** `board_climb_stats.ascensionist_count` for the candidate angle. */
  ascensionistCount: SQLWrapper;
  /** `board_climb_stats.angle` — the candidate. */
  statsAngle: SQLWrapper;
  /** `board_climbs.angle` — the climb's own recorded angle, the tie-break. */
  climbAngle: SQLWrapper;
};

/**
 * Most ascents first, then the climb's own angle, then the lowest angle.
 *
 * `nulls last` is load-bearing on the setter side and a no-op on the sitemap
 * side (which already filters `ascensionist_count >= 10`), so it is stated once
 * here rather than in one of the two callers: Postgres sorts NULLs FIRST under
 * a bare `DESC`, which would hand a climb the angle of a stats row that records
 * no ascents at all.
 *
 * The `COALESCE(...)` tie-break is what the sitemap's own comment called
 * defensive — true for its `DISTINCT ON` shape, where every row in a group joins
 * the same `board_climbs` row and a NULL `climbs.angle` makes the comparison
 * NULL throughout. It is NOT defensive for a non-null `climbs.angle`: on a tie
 * it decides the URL, and dropping it here is exactly how the setter page and
 * the sitemap disagreed.
 */
export function publishedAngleOrderBy(columns: PublishedAngleColumns): SQL[] {
  return [
    sql`${columns.ascensionistCount} desc nulls last`,
    sql`coalesce(${columns.statsAngle} = ${columns.climbAngle}, false) desc`,
    sql`${columns.statsAngle} asc`,
  ];
}
