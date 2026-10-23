import { and, asc, desc, eq, getTableName, ilike, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder, type PgSelect, type PgTable } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { Climb } from '@boardsesh/shared-schema';
import { parseSetIds } from '@boardsesh/board-config';
import { PLAYLIST_SORT_DEFAULT_ORDER, type PlaylistSortOption } from '@boardsesh/climb-filters';
import * as dbSchema from '@boardsesh/db/schema';
import {
  climbSortColumns,
  createPlaylistClimbFilters,
  directedSortSql,
  mapSearchInputToParams,
  personalGradeColumnSql,
  randomSortKeySql,
  withSerialPlan,
  type PlaylistActiveBoard,
  type PlaylistFilterParams,
  type SerialPlanDb,
} from '@boardsesh/db/queries';
import { db } from '../../../../db/client';
import type {
  ActiveBoardFields as ValidatedActiveBoardFields,
  PlaylistClimbViewInputSchema,
} from '../../../../validation/schemas';
import { UNIFIED_TABLES, isValidBoardName } from '../../../../db/queries/util/table-select';
import { escapeLikePattern } from '../../../../utils/like-pattern';
import {
  angleWithStatsSql,
  displayStatsAngleSql,
  hydrateClimbsByRefs,
  type HydrateClimbsOptions,
} from './hydrate-climbs';

// ---------------------------------------------------------------------------
// Views (#6651): sort and filter a playlist's climbs on the server, over the
// whole list, so the list, the play drawer's track and Add to queue all see one
// order. One builder serves every playlist that has a view: a user's playlist
// (`playlist-climbs.ts`) and the smart playlists (`smart-playlists.ts`). Each
// describes its rows as a `PlaylistViewSource`; the filters, the display-angle
// lookups, the sorts and the counts are the same for all of them.
// ---------------------------------------------------------------------------

export type ParsedPlaylistClimbView = z.infer<typeof PlaylistClimbViewInputSchema>;

/** A page row as a playlist reads it, before hydration. */
export type PlaylistRefRow = { climbUuid: string; boardType: string; playlistAngle: number | null };

type SortDirection = 'asc' | 'desc';

/**
 * How a list orders itself, for the sorts that read the list rather than the
 * climb. Every order must end on a key that is unique per list row, so OFFSET
 * paging can neither repeat nor skip a row.
 */
export type PlaylistViewOrder = {
  /** `position`: the list's own order ascending, or its reverse. Also breaks ties under the ranked sorts. */
  own: (direction: SortDirection) => SQL[];
  /** `added`: when each climb entered the list. */
  added: (direction: SortDirection) => SQL[];
  /** What follows the shuffle key: a unique key. */
  unique: SQL[];
};

/**
 * One request's list, as every query a view runs reads it: its rows, how
 * `board_climbs` joins them, which rows the caller may see (the same join and
 * visibility the list uses without a view, so a view only narrows), the angle
 * each row displays, the board the active-board filters read, and the list's own
 * orders.
 */
export type PlaylistViewSource = {
  /** The FROM of every view query: the list's own rows (a table or an aliased subquery). */
  rows: PgTable | SQL;
  /** Inner-joins `board_climbs` to a list row. At most one climb per row. */
  climbJoin: SQL;
  /** Membership and visibility; undefined when `rows` and `climbJoin` already carry both. */
  where: SQL | undefined;
  /** The row's climb uuid, and the angle the playlist keeps for it (NULL for a list that keeps none). */
  refColumns: { climbUuid: SQL<string>; playlistAngle: SQL<number | null> };
  /**
   * The angle a row would like to display, before the stats guard of
   * `displayStatsAngleSql`. Null: none, so each row displays its most-ascended
   * angle, as the hydrator does when it is given no angle.
   */
  preferredAngle: SQL | null;
  activeBoard: PlaylistActiveBoard | null;
  order: PlaylistViewOrder;
  hydrateOptions: (items: ReadonlyArray<PlaylistRefRow>) => HydrateClimbsOptions;
};

/**
 * The active-board fields a view request carries (all-boards playlists, smart
 * playlists): the validation schema's, with the board type any string, since
 * `activeBoardFromFields` checks it.
 */
export type ActiveBoardFields = Omit<ValidatedActiveBoardFields, 'activeBoardName'> & { activeBoardName?: string };

/** The board a view's active-board filters read, from the request's active* fields; null without a known board type. */
export function activeBoardFromFields(fields: ActiveBoardFields): PlaylistActiveBoard | null {
  const { activeBoardName } = fields;
  if (activeBoardName == null || !isValidBoardName(activeBoardName)) return null;
  return {
    boardName: activeBoardName,
    layoutId: fields.activeLayoutId ?? null,
    sizeId: fields.activeSizeId ?? null,
    setIds: fields.activeSetIds == null ? [] : parseSetIds(fields.activeSetIds),
    angle: fields.activeAngle ?? null,
  };
}

/**
 * All-boards hydration: climbs on the active board render their grade at the
 * user's selected angle; every other climb keeps the angle its list stored for
 * it (most-ascents when null, and always for a smart list, which stores none).
 * The hydrator drops back to most-ascents if a climb has no stats at the
 * override angle, so the selected angle never blanks a grade. Shared by a
 * playlist in all-boards mode and a logbook smart list under a view.
 */
export function allBoardsHydrateOptions(
  input: Pick<ActiveBoardFields, 'activeBoardName' | 'activeAngle'>,
  items: ReadonlyArray<PlaylistRefRow>,
): HydrateClimbsOptions {
  const { activeBoardName, activeAngle } = input;
  const angleOverrides = new Map<string, number | null>();
  for (const row of items) {
    const useActiveAngle = activeBoardName != null && activeAngle != null && row.boardType === activeBoardName;
    angleOverrides.set(`${row.boardType}:${row.climbUuid}`, useActiveAngle ? activeAngle : (row.playlistAngle ?? null));
  }
  return { angleOverrides };
}

export type PlaylistPage = {
  climbs: Climb[];
  totalCount: number;
  /** Only on page 0 of a filtering view: the count with no view filter applied. */
  unfilteredCount?: number | null;
  hasMore: boolean;
};

export function paginateResults<T>(results: T[], pageSize: number) {
  const hasMore = results.length > pageSize;
  return { items: hasMore ? results.slice(0, pageSize) : results, hasMore };
}

/**
 * The view's filter fields as search params, through the climb search's own
 * mapper so a filter reads the same in a playlist as on the Climbs list.
 *
 * Personal grades and the grade source only matter to a grade band or the
 * difficulty sort (the client's `toSharedClimbFilterInputFields` sends them on
 * the same rule), so they are dropped otherwise and no personal-grade join is
 * built for nothing.
 */
function toPlaylistFilterParams(view: ParsedPlaylistClimbView, sortBy: PlaylistSortOption): PlaylistFilterParams {
  const sortsByDifficulty = sortBy === 'difficulty';
  const gradeBoundSet = !!view.minGrade || !!view.maxGrade;
  const searchParams = mapSearchInputToParams({
    ...view,
    // The playlist's own sort is read from the view; the mapper only needs to
    // know whether the difficulty sort keeps the grade source.
    sortBy: sortsByDifficulty ? 'difficulty' : null,
    useMyGrades: view.useMyGrades && (gradeBoundSet || sortsByDifficulty) ? true : undefined,
  });
  return { ...searchParams, onlyActiveBoard: view.onlyActiveBoard || undefined };
}

/**
 * ORDER BY for a view. Every order ends on the list's unique key, so OFFSET
 * paging can neither repeat nor skip a row; the ranked sorts break ties in the
 * list's own order first, so equal grades keep the owner's order.
 */
function viewOrderBy(
  order: PlaylistViewOrder,
  sortBy: PlaylistSortOption,
  sortOrder: SortDirection,
  filterParams: PlaylistFilterParams,
  personalGrades: boolean,
): SQL[] {
  switch (sortBy) {
    case 'position':
      return order.own(sortOrder);
    case 'added':
      return order.added(sortOrder);
    case 'random':
      return [sql`${randomSortKeySql(filterParams.sortSeed)} ASC`, ...order.unique];
    case 'difficulty':
    case 'quality':
    case 'ascents':
    case 'name': {
      const sortColumns = climbSortColumns({
        crossAngle: false,
        gradeSource: filterParams.gradeSource,
        personalGrades,
      });
      return [directedSortSql(sortColumns[sortBy], sortOrder), ...order.own('asc')];
    }
  }
}

/**
 * The three queries a view page runs, built on `executor` and not yet awaited.
 * Exported so the EXPLAIN harness (`playlist-climbs-view-explain.test.ts`) can
 * plan exactly what runs here against a full-data database.
 *
 * One stats row per list row, at the angle the row DISPLAYS
 * (`displayStatsAngleSql` over the source's preferred angle — the rule the
 * hydrator applies), so the grade filter and the difficulty sort read exactly
 * the grade the row shows. The Boardsesh grade is read at that angle, or at the
 * preferred angle when the climb has no stats row there (the Climbs list's
 * `gradeJoinAngleSql` fallback), so a climb graded only by the model still has a
 * grade to filter and sort on. Both are LATERAL lookups named after their tables,
 * so the climb search's own predicates and sort keys (`effectiveStatsColumn`
 * without cross-angle, `gradeValueSql`) apply unchanged.
 *
 * The match count rides on the page itself (`count(*) OVER ()`, over the same
 * WHERE before LIMIT/OFFSET), so a page reads the list's rows once. A page past
 * the end returns no row to carry it, so `countQuery` runs the same WHERE on its
 * own, for that case only. `unfilteredCountQuery` is the list's own count,
 * built only when the view filters (a sort alone leaves the count as it was)
 * and only for page 0: clients read the "12 of 117" line from the first page.
 */
export function buildPlaylistViewQueries(
  executor: SerialPlanDb,
  source: PlaylistViewSource,
  view: ParsedPlaylistClimbView,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
) {
  const tables = UNIFIED_TABLES;
  const grades = dbSchema.boardClimbGrades;
  const sortBy: PlaylistSortOption = view.sortBy ?? 'position';
  const sortOrder = view.sortOrder ?? PLAYLIST_SORT_DEFAULT_ORDER[sortBy];
  const filterParams = toPlaylistFilterParams(view, sortBy);
  const filters = createPlaylistClimbFilters(source.activeBoard, filterParams, viewerUserId ?? undefined);
  const personalGradeJoin = filters.personalGradeJoin;

  const sortReadsGrades = sortBy === 'difficulty' && filterParams.gradeSource === 'boardsesh';
  const sortReadsStats = sortBy === 'difficulty' || sortBy === 'quality' || sortBy === 'ascents';
  // The list joins whatever its WHERE or ORDER BY reads, and the grade row
  // whenever it has the stats row, so the hydrator is handed the grade angle the
  // filters would use. The count joins only what its WHERE reads. Every join is
  // a LEFT JOIN to at most one row, so leaving one out of the count cannot
  // change it. The grade lookup reads the stats row's angle, so it always comes
  // with the stats lookup.
  const listStats = filters.needsStats || filters.needsGrades || sortReadsStats || sortReadsGrades;
  const listJoins = { stats: listStats, grades: listStats, personalGrade: personalGradeJoin !== null };
  const countJoins = {
    stats: filters.needsStats || filters.needsGrades,
    grades: filters.needsGrades,
    // Among the filters only the grade band reads the personal grade.
    personalGrade: personalGradeJoin !== null && filters.needsGrades,
  };

  // The angle the stats row is read at. Without a preferred angle it is the
  // most-ascended one, the hydrator's own rule when handed no angle.
  const statsAngle =
    source.preferredAngle === null
      ? displayStatsAngleSql(sql`NULL::int`)
      : displayStatsAngleSql(angleWithStatsSql(source.preferredAngle));
  // The display row as a LATERAL lookup, one primary-key probe per list row.
  // A plain LEFT JOIN on the same condition let the planner hash the whole stats
  // table instead (measured: a full scan of board_climb_stats for a 600-climb
  // playlist), and that table holds every climb at every angle. Named
  // `board_climb_stats` so every `"board_climb_stats"."<column>"` reference
  // outside resolves to this one row; inside, the same name is the table.
  const displayStatsRow = new QueryBuilder()
    .select()
    .from(tables.climbStats)
    .where(
      and(
        eq(tables.climbStats.boardType, tables.climbs.boardType),
        eq(tables.climbStats.climbUuid, tables.climbs.uuid),
        eq(tables.climbStats.angle, statsAngle),
      ),
    )
    .limit(1)
    .as(getTableName(tables.climbStats));
  // The grade angle: the stats row's, else the preferred angle. Reads the
  // lateral stats row above, so the grade lookup must come after it.
  const gradeAngle =
    source.preferredAngle === null
      ? sql<number | null>`${tables.climbStats.angle}`
      : sql<number | null>`COALESCE(${tables.climbStats.angle}, ${source.preferredAngle})`;
  // Same LATERAL shape for the grades table (1.3 GB in production): a primary-key
  // probe per row, never a hash over the table.
  const displayGradeRow = new QueryBuilder()
    .select()
    .from(grades)
    .where(
      and(
        eq(grades.boardType, tables.climbs.boardType),
        eq(grades.climbUuid, tables.climbs.uuid),
        eq(grades.angle, gradeAngle),
      ),
    )
    .limit(1)
    .as(getTableName(grades));

  // Every column the queries select comes from the list's rows or the inner
  // `board_climbs` join, or is a typed `sql` expression, so these LEFT JOINs
  // leave the row type as it was; the cast back only restores that.
  function withViewJoins<Query extends PgSelect>(query: Query, joins: typeof listJoins): Query {
    let joined: PgSelect = query;
    if (joins.stats) joined = joined.leftJoinLateral(displayStatsRow, sql`true`);
    if (joins.grades) joined = joined.leftJoinLateral(displayGradeRow, sql`true`);
    if (joins.personalGrade && personalGradeJoin) {
      joined = joined.leftJoin(personalGradeJoin.subquery, personalGradeJoin.on);
    }
    return joined as Query;
  }

  const filteredWhere = and(source.where, ...filters.allRows, ...filters.activeBoardOnly);

  const countQuery = withViewJoins(
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(source.rows)
      .innerJoin(tables.climbs, source.climbJoin)
      .$dynamic(),
    countJoins,
  ).where(filteredWhere);

  // Paid on every filtering page 0, the play drawer's too: accepted (~40 ms on 6k ticks, <1 ms on playlists).
  const unfilteredCountQuery =
    filters.hasFilters && page === 0
      ? executor
          .select({ count: sql<number>`count(*)::int` })
          .from(source.rows)
          .innerJoin(tables.climbs, source.climbJoin)
          .where(source.where)
      : null;

  const nullInt = sql<number | null>`NULL::int`;
  const refQuery = withViewJoins(
    executor
      .select({
        climbUuid: source.refColumns.climbUuid,
        boardType: tables.climbs.boardType,
        playlistAngle: source.refColumns.playlistAngle,
        statsAngle: listJoins.stats ? sql<number | null>`${tables.climbStats.angle}` : nullInt,
        gradeAngle: listJoins.grades ? gradeAngle : nullInt,
        myDifficulty: personalGradeJoin ? sql<number | null>`${personalGradeColumnSql()}` : nullInt,
        // Every row the WHERE passes, before the page is cut.
        matchCount: sql<number>`(count(*) OVER ())::int`,
      })
      .from(source.rows)
      .innerJoin(tables.climbs, source.climbJoin)
      .$dynamic(),
    listJoins,
  )
    .where(filteredWhere)
    .orderBy(...viewOrderBy(source.order, sortBy, sortOrder, filterParams, personalGradeJoin !== null))
    .limit(pageSize + 1)
    .offset(page * pageSize);

  return { countQuery, unfilteredCountQuery, refQuery, listJoins, personalGrades: personalGradeJoin !== null };
}

/** What one view page read, before hydration. */
type PlaylistViewRun = Awaited<ReturnType<typeof runPlaylistViewQueries>>;

/**
 * Run a view page's queries on `tx`, which must already carry the serial-plan
 * guard (`withSerialPlan`): the view joins board_climb_stats and
 * board_climb_grades per list row, the shape whose parallel plans exhausted
 * /dev/shm in production (pgCode 53100, #4235). One read of the list for the
 * page and its count, a second for the unfiltered count on page 0 of a
 * filtering view, and the count query only for a page past the end.
 */
async function runPlaylistViewQueries(
  tx: SerialPlanDb,
  source: PlaylistViewSource,
  view: ParsedPlaylistClimbView,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
) {
  const queries = buildPlaylistViewQueries(tx, source, view, page, pageSize, viewerUserId);
  const refRows = await queries.refQuery;
  let totalCount = refRows[0]?.matchCount ?? 0;
  if (refRows.length === 0 && page > 0) totalCount = (await queries.countQuery)[0]?.count ?? 0;
  const unfilteredRows = queries.unfilteredCountQuery ? await queries.unfilteredCountQuery : null;
  return {
    totalCount,
    unfilteredCount: unfilteredRows ? (unfilteredRows[0]?.count ?? 0) : null,
    refRows,
    listJoins: queries.listJoins,
    personalGrades: queries.personalGrades,
  };
}

/** Hydrate a view page with the angles it was sorted and filtered by. */
async function hydratePlaylistViewPage(
  source: PlaylistViewSource,
  run: PlaylistViewRun,
  pageSize: number,
  viewerUserId: string | null | undefined,
): Promise<PlaylistPage> {
  const { totalCount, unfilteredCount, refRows, listJoins, personalGrades } = run;
  const { items, hasMore } = paginateResults(refRows, pageSize);
  const refKey = (row: PlaylistRefRow) => `${row.boardType}:${row.climbUuid}`;

  const hydrateOptions: HydrateClimbsOptions = { ...source.hydrateOptions(items), viewerUserId };
  if (listJoins.stats) {
    hydrateOptions.resolvedAngles = new Map(
      items.map((row) => [refKey(row), { statsAngle: row.statsAngle ?? null, gradeAngle: row.gradeAngle ?? null }]),
    );
  }
  if (personalGrades) {
    hydrateOptions.myDifficulties = new Map(items.map((row) => [refKey(row), row.myDifficulty ?? null]));
  }
  const climbs = await hydrateClimbsByRefs(
    items.map((row) => ({ climbUuid: row.climbUuid, boardType: row.boardType })),
    hydrateOptions,
  );

  return { climbs, totalCount, unfilteredCount, hasMore };
}

/**
 * A list page under a view: its queries in one transaction, so one pooled
 * connection, with per-gather parallelism off (`withSerialPlan`), then hydrated
 * outside it with the angles the page was sorted and filtered by.
 */
export async function fetchPlaylistView(
  source: PlaylistViewSource,
  view: ParsedPlaylistClimbView,
  page: number,
  pageSize: number,
  viewerUserId: string | null | undefined,
): Promise<PlaylistPage> {
  const run = await withSerialPlan(db, (tx) => runPlaylistViewQueries(tx, source, view, page, pageSize, viewerUserId));
  return hydratePlaylistViewPage(source, run, pageSize, viewerUserId);
}

/**
 * The setters of a list's climbs, most climbs first, then by username: every row
 * of the source the viewer can see (its own membership and visibility, no view
 * filter), grouped on `board_climbs.setter_username`. That is the column the
 * view's setter filter matches, exactly (`inArray`), so filtering the list to a
 * returned username leaves `climbCount` rows. `search` is a case-insensitive
 * username prefix. It needs no `withSerialPlan`: there are no LATERAL stats or
 * grade lookups here, just one grouped scan of the source's rows.
 */
export async function fetchPlaylistSetters(
  source: PlaylistViewSource,
  search: string | undefined,
  limit: number,
): Promise<Array<{ username: string; climbCount: number }>> {
  const setter = UNIFIED_TABLES.climbs.setterUsername;
  const rows = await db
    .select({ username: setter, climbCount: sql<number>`count(*)::int` })
    .from(source.rows)
    .innerJoin(UNIFIED_TABLES.climbs, source.climbJoin)
    .where(
      and(
        source.where,
        isNotNull(setter),
        ne(setter, ''),
        search ? ilike(setter, `${escapeLikePattern(search)}%`) : undefined,
      ),
    )
    .groupBy(setter)
    .orderBy(desc(sql`count(*)`), asc(setter))
    .limit(limit);
  // The WHERE already drops null and empty names; this only narrows the
  // column's nullable type to string.
  return rows.flatMap((row) => (row.username ? [{ username: row.username, climbCount: row.climbCount }] : []));
}

/**
 * The orders of a list whose rows carry their place in its own order as
 * `natural_rank` (1 = first, unique per row): the smart playlists' logbook
 * lists. `added` reads the time a climb entered the list, newest first by
 * default. Where the list's own order is that time (Liked: most recently liked
 * first), `added` is the same order; where it is not (latest five-star climb,
 * attempt totals), the list records no entry time, and `added` falls back to the
 * list's own order, newest-first meaning the list as it stands.
 */
export function naturalRankOrder(naturalRank: SQL): PlaylistViewOrder {
  const own = (direction: SortDirection) => [direction === 'asc' ? asc(naturalRank) : desc(naturalRank)];
  return {
    own,
    added: (direction) => own(direction === 'desc' ? 'asc' : 'desc'),
    unique: [asc(naturalRank)],
  };
}
