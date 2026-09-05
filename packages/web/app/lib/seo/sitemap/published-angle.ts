import 'server-only';
import { ANGLES, getRoutableBoardAngles } from '@boardsesh/board-config';
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
 *
 * `getRoutableBoardAngles`, not `ANGLES`. The two are different lists and the
 * difference is the whole point: `ANGLES` is the *picker* — practical 5-degree
 * steps, and only 25° and 40° for MoonBoard — while the write contracts accept
 * every integer 0-90 and Grasshopper's real -5° slab. A climb stored at a
 * non-picker angle still has a routable URL (`parseBoardAngleSegment` resolves
 * it), so picking from `ANGLES` would refuse to publish pages that exist.
 */
export function publishableAngles(boardName: BoardName): number[] {
  return [...getRoutableBoardAngles(boardName)];
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
  // Grouped by the angle list itself, not one branch per board: routability has
  // two shapes today (Grasshopper carries -5°, everything else does not), so a
  // branch per board would repeat the same 91-element array eight times. Still
  // derived from `publishableAngles`, so a third shape appearing upstream lands
  // here on its own.
  const byAngleList = new Map<string, { angles: number[]; boards: BoardName[] }>();
  for (const boardName of Object.keys(ANGLES) as BoardName[]) {
    const angles = publishableAngles(boardName);
    const key = angles.join(',');
    const existing = byAngleList.get(key);
    if (existing) existing.boards.push(boardName);
    else byAngleList.set(key, { angles, boards: [boardName] });
  }

  const branches = [...byAngleList.values()].map(
    ({ angles, boards }) =>
      sql`when ${boardType} in (${sql.join(
        boards.map((boardName) => sql`${boardName}`),
        sql`, `,
      )}) then ${intArrayLiteral(angles)}`,
  );

  return sql`${statsAngle} = any(case ${sql.join(branches, sql` `)} else ARRAY[]::int[] end)`;
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
