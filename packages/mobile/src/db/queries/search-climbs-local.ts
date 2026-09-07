import { getLocalUserId, type OfflineDatabase } from '@boardsesh/offline-sync';
import type { BoardName, Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import { isNoMatch } from '@boardsesh/shared-schema';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import { getTallWideScope } from '@boardsesh/board-constants';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { getGradeLabel, getClimbStars } from '../../lib/grade-label';

/**
 * On-device climb search over local SQLite (board_climbs ⋈ board_climb_stats),
 * used when the device is offline and the active board has been downloaded. It
 * mirrors the server's LEFT-JOIN "standard" search path
 * (packages/db/src/queries/climbs/{search-climbs,create-climb-filters}.ts) — the
 * stats-driven INNER-JOIN path is a Postgres index optimization with no on-device
 * benefit, and the standard path is the faithful superset for all sort orders.
 *
 * Two differences from the server SQL, both forced by how the data lands locally:
 *  - required_set_ids / compatible_size_ids are JSON-string TEXT (the pull client
 *    JSON.stringifies the int[] columns), so array membership uses json_each()
 *    instead of the Postgres @> / <@ operators — with explicit NULL guards so the
 *    subset semantics match (a non-draft climb with NULL required sets is excluded).
 *  - grade rounding uses CAST(ROUND(x) AS INTEGER) to compare against integer grade ids.
 *  - is_hidden is a nullable INTEGER here (added by on-device migration v5) rather
 *    than the server's NOT NULL boolean, so the browse predicate COALESCEs the NULL
 *    of a pre-v5 row to "visible" instead of dropping it.
 *
 * SQLite's default NULL ordering (NULLs first on ASC, last on DESC) already matches
 * the server's explicit NULLS FIRST/LAST, so no explicit clause is needed. Personal
 * progress reads the local boardsesh_ticks (the device holds one user's ticks).
 *
 * Filters that need tables we don't sync (hold-state, zone, tall/wide, beta videos,
 * drafts) are NOT expressible here — `isOfflineSearchSupported` gates them out so
 * the caller can fall back to the network (online) or show a limited-offline notice.
 */

export type LocalSearchResult = { climbs: Climb[]; hasMore: boolean };

// `null` is a real bind value here, not an absence: with no `local_user_id`
// stamp the owner predicate binds NULL, and `user_id = NULL` never matches — so
// the read degrades to this device's own unsynced writes rather than to
// everyone's rows.
type Bind = string | number | null;

const DEFAULT_PAGE_SIZE = 20;

const SORT_ALIASES: Record<string, string> = {
  ascents: 'ascents',
  difficulty: 'difficulty',
  name: 'name',
  quality: 'quality',
  popular: 'popular',
  creation: 'creation',
  random: 'random',
  created_at: 'creation',
  published_at: 'creation',
};

// Deterministic seeded shuffle for the offline `random` sort. SQLite has no
// md5(), so mix a weighted sum of uuid characters with the per-search seed (`?`)
// via a multiplicative hash mod a large prime. Sample every ~3rd position across
// the string (not just a handful) so uuids sharing a common prefix/segment — e.g.
// a timestamp-ordered v1 uuid — still land on distinct positions and don't
// cluster. COALESCE guards positions past a short uuid's end (unicode('') is
// NULL). This won't reproduce the server's md5 order byte-for-byte — an accepted
// offline gap, like the ASCII-collation note above — but it's stable per seed so
// OFFSET pagination doesn't reshuffle mid-scroll.
const RANDOM_ORDER_EXPR = `(
  (COALESCE(unicode(substr(c.uuid, 1, 1)), 0) * 131
   + COALESCE(unicode(substr(c.uuid, 4, 1)), 0) * 137
   + COALESCE(unicode(substr(c.uuid, 7, 1)), 0) * 139
   + COALESCE(unicode(substr(c.uuid, 10, 1)), 0) * 149
   + COALESCE(unicode(substr(c.uuid, 13, 1)), 0) * 151
   + COALESCE(unicode(substr(c.uuid, 16, 1)), 0) * 157
   + COALESCE(unicode(substr(c.uuid, 19, 1)), 0) * 163
   + COALESCE(unicode(substr(c.uuid, 22, 1)), 0) * 167
   + COALESCE(unicode(substr(c.uuid, 25, 1)), 0) * 173
   + COALESCE(unicode(substr(c.uuid, 28, 1)), 0) * 179
   + COALESCE(unicode(substr(c.uuid, 31, 1)), 0) * 181
   + LENGTH(c.uuid) * 191
   + ?) * 2654435761
) % 2147483647`;

function normalizeSortBy(sortBy: string | null | undefined): string {
  if (!sortBy) return 'ascents';
  return SORT_ALIASES[sortBy] ?? 'creation';
}

function parseSetIds(setIds: string | null | undefined): number[] {
  if (!setIds) return [];
  return setIds
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

// Escape LIKE metacharacters so a search for "50%" or "a_b" matches literally.
// SQLite LIKE is case-insensitive for ASCII only (accented letters won't fold) —
// an accepted offline limitation vs Postgres ILIKE.
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type HoldFilters = { anyHolds: number[]; notHolds: number[]; hasHoldState: boolean };

function parseHoldsFilter(holdsFilter: unknown): HoldFilters {
  const anyHolds: number[] = [];
  const notHolds: number[] = [];
  let hasHoldState = false;
  if (holdsFilter && typeof holdsFilter === 'object') {
    for (const [keyRaw, entry] of Object.entries(holdsFilter as Record<string, unknown>)) {
      // Same shape as the online parser in
      // packages/db/src/queries/climbs/create-climb-filters.ts — hold id 0 is a
      // real hold on Woods, and the two must agree or an offline search answers a
      // filter the online one drops.
      const holdKey = String(keyRaw).replace('hold_', '');
      const holdId = Number(holdKey);
      if (!/^\d+$/.test(holdKey) || !Number.isSafeInteger(holdId) || !entry || typeof entry !== 'object') continue;
      for (const [type, mode] of Object.entries(entry as Record<string, unknown>)) {
        if (mode !== 'include' && mode !== 'exclude') continue;
        if (type === 'ANY') {
          if (mode === 'include') anyHolds.push(holdId);
          else notHolds.push(holdId);
        } else if (type === 'STARTING' || type === 'HAND' || type === 'FOOT' || type === 'FINISH') {
          // Needs board_climb_holds — not synced locally.
          hasHoldState = true;
        }
      }
    }
  }
  return { anyHolds, notHolds, hasHoldState };
}

/**
 * Whether this search's active filters are fully expressible against the local
 * schema. False when a filter needs a table we don't sync (hold-state, zone,
 * tall/wide, beta videos) or the drafts path (owner resolution + no stats).
 */
export function isOfflineSearchSupported(input: ClimbSearchInput): boolean {
  // projectsOnly, boulders/routes, benchmarks, name, setter, grade range, min
  // ascents/rating, present-hold, tall/wide (via the synced compatible_size_ids,
  // see buildJoinAndWhere), and personal progress/rating filters are all
  // supported (synced ticks carry quality + climbed_at).
  // These need tables we don't sync (or the drafts owner path), so fall back:
  if (input.onlyDrafts) return false;
  // Personal grades (#4828) are NOT listed here: buildJoinAndWhere and
  // sortColumnSql implement the same latest-graded-tick rule the server does,
  // against the synced ticks (which carry both `difficulty` and `uuid`). This
  // function returns TRUE by default, so anything it cannot actually answer must
  // be added above — a downloaded board reads locally even while online, so a
  // silently-ignored filter here is wrong results with no network fallback.
  if (input.onlyWithBetaVideos) return false;
  if (input.zoneBox) return false;
  const { hasHoldState } = parseHoldsFilter(input.holdsFilter);
  if (hasHoldState) return false;
  return true;
}

// Per-status tick-count / existence fragments, all scoped to (climb, board,
// angle) AND to the climber who owns the local rows.
const COMPLETED_STATUSES = "('flash', 'send')";

/**
 * The row-level half of the auth-scoping contract (docs/offline-reads.md).
 *
 * Sign-out wipes the user tables, but best-effort: a locked database or a crash
 * mid-sign-out leaves the previous account's ticks behind, and these reads used
 * to have no user predicate at all — so one failed wipe showed user A's send
 * and attempt glyphs to user B.
 *
 * `user_id IS NULL` is not a loophole, it is required: the offline dual-write
 * (`writeTickLocal`) inserts the climber's own tick before it has a server row,
 * and rows written before the writer started stamping `user_id` are still on
 * disk. Both are this device's own writes, made while this account was signed
 * in — the same account the stamp names.
 *
 * `ownerUserId` is the `local_user_id` stamp, not the live session id: the
 * stamp IS the device's record of whose rows these are, and the reader-level
 * `assertLocalUserDataOwner` is what checks it against the signed-in climber.
 * With no stamp (a fresh or pre-upgrade database) the predicate degrades to
 * "this device's own unsynced writes", which is the safe direction.
 */
function ownedTicks(alias: string): string {
  return `(${alias}.user_id = ? OR ${alias}.user_id IS NULL)`;
}

function ticksExists(negated: boolean, statusSql: string): string {
  return `${negated ? 'NOT EXISTS' : 'EXISTS'} (SELECT 1 FROM boardsesh_ticks t
    WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND ${ownedTicks('t')} AND ${statusSql})`;
}

// ---------------------------------------------------------------------------
// Personal grades (#4828), the on-device half of the rule the server states in
// packages/db/src/queries/climbs/create-climb-filters.ts:
//
//   personal grade  := difficulty of the LATEST tick for
//                      (user, board_type, climb_uuid, angle) whose difficulty is
//                      NOT NULL, ordered by (climbed_at DESC, uuid DESC)
//   effective grade := COALESCE(clamped personal grade, ROUND(display_difficulty))
//
// The local ticks table carries both `difficulty` and `uuid`, so unlike the
// personal-RATING filter above — which has to fall back to updated_at because
// the server tie-breaks on a bigserial id this table lacks — this half can tie
// -break on exactly the same key the server does, and an offline search returns
// the same rows in the same order as an online one.
// ---------------------------------------------------------------------------

/** Scale bounds, derived from the shared table (currently 10..33), never hardcoded. */
const GRADE_SCALE_MIN_ID = BOULDER_GRADES[0].difficulty_id;
const GRADE_SCALE_MAX_ID = BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id;

/** SQLite's MIN/MAX are 2-arg scalar functions here, not aggregates. */
function clampToBoulderScale(difficultyExpr: string): string {
  return `MIN(MAX(${difficultyExpr}, ${GRADE_SCALE_MIN_ID}), ${GRADE_SCALE_MAX_ID})`;
}

/** The crowd's rounded grade — the integer the filter and sort key on by default. */
const ROUNDED_CROWD_GRADE = 'CAST(ROUND(s.display_difficulty) AS INTEGER)';

/**
 * The climber's own clamped grade for the outer row's climb, or NULL when they
 * never graded it. Binds: board_type, angle, ownerUserId.
 *
 * A correlated scalar subquery rather than the server's DISTINCT ON join: the
 * local ticks table holds one climber's ticks for boards they downloaded, so
 * `idx_ticks_climb` makes each probe a handful of rows and there is no 220k-row
 * candidate set for a per-row probe to multiply against.
 */
const MY_GRADE_SUBQUERY = `(SELECT ${clampToBoulderScale('mg.difficulty')}
    FROM boardsesh_ticks mg
    WHERE mg.climb_uuid = c.uuid AND mg.board_type = ? AND mg.angle = ? AND ${ownedTicks('mg')}
    AND mg.difficulty IS NOT NULL
    ORDER BY mg.climbed_at DESC, mg.uuid DESC
    LIMIT 1)`;

/** COALESCE(my grade, the crowd's) — what the difficulty sort orders on. */
const EFFECTIVE_GRADE_EXPR = `COALESCE(${MY_GRADE_SUBQUERY}, ${ROUNDED_CROWD_GRADE})`;

/** The three binds `MY_GRADE_SUBQUERY` (and so `EFFECTIVE_GRADE_EXPR`) needs. */
function myGradeBinds(boardType: string, angle: number, ownerUserId: string | null): Bind[] {
  return [boardType, angle, ownerUserId];
}

/** Whether this search keys grades off the climber's own ticks. */
function usesMyGrades(input: ClimbSearchInput): boolean {
  return !!input.useMyGrades;
}

type JoinAndWhere = { joinSql: string; whereSql: string; joinBinds: Bind[]; whereBinds: Bind[] };

function buildJoinAndWhere(input: ClimbSearchInput, ownerUserId: string | null): JoinAndWhere {
  const boardType = input.boardName;
  const angle = input.angle;
  const setIds = parseSetIds(input.setIds);
  const isMoonboard = boardType === 'moonboard';

  // Stats drive grade/quality/ascents; grades add the Boardsesh grade + confidence
  // for the requested angle (mirrors the server's board_climb_grades LEFT JOIN). Both
  // are LEFT JOINs on (climb_uuid, board_type, angle) — one row each via their PK — so
  // they never multiply the result set, and a climb with no grade row reads null.
  const joinBinds: Bind[] = [boardType, angle, boardType, angle];
  const joinSql = `LEFT JOIN board_climb_stats s
    ON s.climb_uuid = c.uuid AND s.board_type = ? AND s.angle = ?
    LEFT JOIN board_climb_grades g
    ON g.climb_uuid = c.uuid AND g.board_type = ? AND g.angle = ?`;

  const conditions: string[] = [];
  const whereBinds: Bind[] = [];
  const push = (clause: string, ...binds: Bind[]) => {
    conditions.push(clause);
    whereBinds.push(...binds);
  };

  // Base: board / layout / listed / non-draft.
  push('c.board_type = ?', boardType);
  push('c.layout_id = ?', input.layoutId);
  push('c.is_listed = 1');
  push('c.is_draft = 0');

  // Community-hidden climbs, mirroring hiddenClimbCondition in
  // packages/db/src/queries/climbs/create-climb-filters.ts: gone from browsing,
  // still findable by name. COALESCE because is_hidden arrived in the on-device
  // schema at migration v5 and rows pulled before the server started sending it
  // are NULL — an unknown flag reads as visible, which is the safe direction for
  // a column the sync will refresh.
  if (!input.name) push('COALESCE(c.is_hidden, 0) = 0');

  // Boulders / routes on frames_count (NULL is legacy single-frame → boulder).
  const wantsBoulders = !!input.boulders;
  const wantsRoutes = !!input.routes;
  if (wantsBoulders && !wantsRoutes) {
    push('(c.frames_count = 1 OR c.frames_count IS NULL)');
  } else if (wantsRoutes && !wantsBoulders) {
    push('c.frames_count > 1');
  }

  // Size: compatible_size_ids contains sizeId (skipped for boards without size
  // variants — moonboard — via the shared isSizeScopedBoard predicate).
  if (isSizeScopedBoard(boardType)) {
    push(
      'c.compatible_size_ids IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(c.compatible_size_ids) WHERE value = ?)',
      input.sizeId,
    );
  }

  // Set membership (subset): every required set is in the selected sets. NULL
  // required_set_ids is excluded for non-draft/non-moonboard (matches Postgres
  // NULL <@ semantics); moonboard allows NULL (backfill pending).
  if (setIds.length > 0) {
    const placeholders = setIds.map(() => '?').join(', ');
    const subsetProbe = `NOT EXISTS (SELECT 1 FROM json_each(c.required_set_ids) WHERE value NOT IN (${placeholders}))`;
    if (isMoonboard) {
      push(`(c.required_set_ids IS NULL OR ${subsetProbe})`, ...setIds);
    } else {
      push(`(c.required_set_ids IS NOT NULL AND ${subsetProbe})`, ...setIds);
    }
  }

  // Name (case-insensitive ASCII LIKE).
  if (input.name) {
    push(`c.name LIKE ? ESCAPE '\\'`, `%${escapeLike(input.name)}%`);
  }

  // Setter name(s).
  if (input.setter && input.setter.length > 0) {
    push(`c.setter_username IN (${input.setter.map(() => '?').join(', ')})`, ...input.setter);
  }

  // Min ascents (mutually exclusive with projectsOnly).
  if (input.minAscents && !input.projectsOnly) {
    push('s.ascensionist_count >= ?', input.minAscents);
  }

  // Grade range. Keys on the crowd's rounded display difficulty by default, and
  // on the climber's own grade when they asked for it (#4828) — written as the
  // same two disjoint halves the server uses (create-climb-filters.ts):
  //
  //   1. no graded tick here AND the crowd's grade is in range; OR
  //   2. a graded tick whose clamped difficulty is in range, with no NEWER
  //      graded tick superseding it.
  //
  // The `NOT EXISTS` on `(climbed_at, uuid) >` is the whole of "latest": without
  // it a climb re-graded down would still match on its stale higher grade.
  const roundedGrade = ROUNDED_CROWD_GRADE;
  const gradeInRange = (gradeExpr: string): { clause: string; binds: number[] } | null => {
    if (input.minGrade && input.maxGrade) {
      return { clause: `${gradeExpr} BETWEEN ? AND ?`, binds: [input.minGrade, input.maxGrade] };
    }
    if (input.minGrade) return { clause: `${gradeExpr} >= ?`, binds: [input.minGrade] };
    if (input.maxGrade) return { clause: `${gradeExpr} <= ?`, binds: [input.maxGrade] };
    return null;
  };
  const crowdRange = gradeInRange(roundedGrade);
  if (crowdRange) {
    if (usesMyGrades(input)) {
      // The SAME expression the sort and the projection use, not a second
      // spelling of the rule. This filter was originally written as
      // NOT EXISTS / EXISTS halves under an OR — the exact shape that measured
      // a 7.1x regression on the server before a review caught it — and it also
      // meant the local filter and the local sort could drift apart while both
      // looked right. One probe per candidate row, one definition.
      const personalRange = gradeInRange(EFFECTIVE_GRADE_EXPR)!;
      push(personalRange.clause, ...myGradeBinds(boardType, angle, ownerUserId), ...personalRange.binds);
    } else {
      push(crowdRange.clause, ...crowdRange.binds);
    }
  }

  // Min rating (quality_average is canonical 1-5).
  if (input.minRating) {
    push('s.quality_average >= ?', input.minRating);
  }

  // Grade accuracy: |rounded display - difficulty_average| <= accuracy.
  // parseFloat (not Number) to MATCH THE SERVER (types.ts parseGradeAccuracy):
  // '1.5abc' filters at 1.5 there, so it must here too — local-first search
  // must return the same rows the network would for the same input, even for
  // malformed deep-link values.
  const gradeAccuracy = input.gradeAccuracy ? parseFloat(String(input.gradeAccuracy)) : NaN;
  if (Number.isFinite(gradeAccuracy)) {
    push(`ABS(${roundedGrade} - s.difficulty_average) <= ?`, gradeAccuracy);
  }

  // Benchmarks only.
  if (input.onlyBenchmarks) {
    push('s.benchmark_difficulty > 0');
  }

  // Projects only: 0 ascents or no stats row.
  if (input.projectsOnly) {
    push('COALESCE(s.ascensionist_count, 0) = 0');
  }

  // Present-hold filters via the anchored frames token (ANY / NOT-present).
  const { anyHolds, notHolds } = parseHoldsFilter(input.holdsFilter);
  for (const holdId of anyHolds) {
    push(`c.frames LIKE ? ESCAPE '\\'`, `%p${holdId}r%`);
  }
  for (const holdId of notHolds) {
    push(`c.frames NOT LIKE ? ESCAPE '\\'`, `%p${holdId}r%`);
  }

  // Tall / Wide (size-grid) filters over the synced compatible_size_ids —
  // mirrors the server (create-climb-filters.ts) so an online and offline search
  // return the same rows. getTallWideScope fails closed (empty sets) when the
  // active size is the shortest/narrowest in its axis or the board has no grid,
  // so the filter then matches nothing (`0 = 1`), exactly like the server's
  // `false`. The `IS NOT NULL` guard matches the server's `NOT (NULL && …)` NULL
  // handling (a null array is not tall/wide) — json_each(NULL) would otherwise
  // yield an empty set that a bare NOT EXISTS reads as a match.
  if (input.onlyTallClimbs || input.onlyWideClimbs) {
    const { narrowerSizeIds, shorterSizeIds, hasNarrower, hasShorter } = getTallWideScope(
      boardType as BoardName,
      input.layoutId,
      input.sizeId,
    );
    const pushSizeGridFilter = (enabled: boolean | null | undefined, hasSmaller: boolean, smallerSizeIds: number[]) => {
      if (!enabled) return;
      if (!hasSmaller) {
        push('0 = 1');
        return;
      }
      const placeholders = smallerSizeIds.map(() => '?').join(', ');
      push(
        `c.compatible_size_ids IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(c.compatible_size_ids) WHERE value IN (${placeholders}))`,
        ...smallerSizeIds,
      );
    };
    pushSizeGridFilter(input.onlyTallClimbs, hasShorter, shorterSizeIds);
    pushSizeGridFilter(input.onlyWideClimbs, hasNarrower, narrowerSizeIds);
  }

  // Personal progress against local ticks (device is single-user).
  if (input.hideAttempted) push(ticksExists(true, "t.status = 'attempt'"), boardType, angle, ownerUserId);
  if (input.hideCompleted) push(ticksExists(true, `t.status IN ${COMPLETED_STATUSES}`), boardType, angle, ownerUserId);
  if (input.showOnlyAttempted) push(ticksExists(false, "t.status = 'attempt'"), boardType, angle, ownerUserId);
  if (input.showOnlyCompleted)
    push(ticksExists(false, `t.status IN ${COMPLETED_STATUSES}`), boardType, angle, ownerUserId);

  // Personal rating, mirroring create-climb-filters.ts case for case so an
  // offline search returns the same rows as an online one. The local ticks
  // table has no bigserial id, so the latest-rating tie-break falls back to
  // updated_at where the server uses id — only reachable when two ratings of
  // one climb share a climbed_at.
  if (input.onlyRatedByMe) push(ticksExists(false, 't.quality IS NOT NULL'), boardType, angle, ownerUserId);
  if (input.minUserRating) {
    push(
      `NOT EXISTS (SELECT 1 FROM boardsesh_ticks rating_below
        WHERE rating_below.climb_uuid = c.uuid AND rating_below.board_type = ? AND rating_below.angle = ?
        AND ${ownedTicks('rating_below')}
        AND rating_below.quality IS NOT NULL AND rating_below.quality < ?
        AND NOT EXISTS (SELECT 1 FROM boardsesh_ticks rating_newer
          WHERE rating_newer.climb_uuid = rating_below.climb_uuid
          AND rating_newer.board_type = rating_below.board_type
          AND rating_newer.angle = rating_below.angle
          AND ${ownedTicks('rating_newer')}
          AND rating_newer.quality IS NOT NULL
          AND (rating_newer.climbed_at > rating_below.climbed_at
            OR (rating_newer.climbed_at = rating_below.climbed_at
              AND rating_newer.updated_at > rating_below.updated_at))))`,
      boardType,
      angle,
      ownerUserId,
      input.minUserRating,
      ownerUserId,
    );
  }

  return { joinSql, whereSql: conditions.join(' AND '), joinBinds, whereBinds };
}

function sortColumnSql(sortBy: string, useMyGrades: boolean): string {
  switch (sortBy) {
    case 'ascents':
      return 's.ascensionist_count';
    case 'difficulty':
      // With personal grades on, order by the SAME value the filter admitted
      // the row on, so a climb the climber re-graded to V10 sorts among the
      // V10s rather than staying with the V0s (#4828).
      //
      // Ordering on the PROJECTED alias rather than repeating the subquery:
      // SQLite happily takes a result-column alias inside an ORDER BY
      // expression, and doing so evaluates the per-row probe once instead of
      // once for the SELECT and again for the sort. The alias only exists when
      // personal grades are on, which is exactly this branch.
      return useMyGrades ? `COALESCE(my_difficulty, ${ROUNDED_CROWD_GRADE})` : ROUNDED_CROWD_GRADE;
    case 'name':
      // NOCASE so 'apple' sorts before 'Zebra', matching Postgres's locale
      // collation (SQLite's default BINARY puts all uppercase first). ASCII
      // names dominate the catalogs, so ASCII-only NOCASE is close enough.
      return 'c.name COLLATE NOCASE';
    case 'quality':
      return 's.quality_average';
    case 'popular':
      return 'popular_total';
    case 'creation':
    default:
      return 'c.created_at';
  }
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type LocalClimbRow = {
  uuid: string;
  setter_username: string | null;
  user_id: string | null;
  name: string | null;
  frames: string | null;
  is_draft: number | null;
  /** SQLite integer mirror of `board_climbs.is_hidden`; NULL on rows pulled
   *  before the column existed (migration v5), read as visible. */
  is_hidden: number | null;
  characteristics: string | null;
  created_at: string | null;
  published_at: string | null;
  frames_count: number | null;
  frames_pace: number | null;
  ascensionist_count: number | null;
  display_difficulty: number | null;
  difficulty_average: number | null;
  quality_average: number | null;
  benchmark_difficulty: number | null;
  user_ascents: number | null;
  user_attempts: number | null;
  /** COALESCE(universal_grade, local_grade) from board_climb_grades; null when unjoined. */
  boardsesh_difficulty: number | null;
  /** Boardsesh grade confidence tier from board_climb_grades; null when unjoined. */
  boardsesh_confidence: string | null;
  /** Setter-written notes. Selected by both the detail read and the search read
   *  (#4494 — the play drawer renders it for whatever climb the list opened),
   *  so it is always present on the row; null when the setter wrote none. */
  description: string | null;
  /** `board_climbs.compatible_size_ids` as the pull client stores it: a JSON
   *  array in TEXT (see the offline schema), not a native array. Null when the
   *  server had no compatibility data for the climb. */
  compatible_size_ids: string | null;
  /** The climber's own clamped grade for this climb+angle. Selected only when
   *  the search asked for personal grades; null within such a search when they
   *  never graded the climb (#4828). */
  my_difficulty?: number | null;
};

export function parseCharacteristics(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * Decode the JSON-in-TEXT `compatible_size_ids` column into the number array the
 * shared `Climb` carries. Anything that isn't an array of finite numbers reads
 * as "no compatibility data" (null) rather than as an empty list, because an
 * empty list would otherwise be read as "fits nothing" by a stricter consumer.
 */
export function parseCompatibleSizeIds(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const sizeIds = parsed.filter((sizeId): sizeId is number => typeof sizeId === 'number' && Number.isFinite(sizeId));
    return sizeIds.length > 0 ? sizeIds : null;
  } catch {
    return null;
  }
}

export function mapRowToClimb(
  row: LocalClimbRow,
  boardType: string,
  layoutId: number,
  angle: number,
  hasPersonalGrade = false,
): Climb {
  const characteristics = parseCharacteristics(row.characteristics);
  const difficultyId = row.display_difficulty === null ? null : Math.round(row.display_difficulty);
  const difficultyError =
    row.difficulty_average !== null && row.display_difficulty !== null
      ? String(roundTo(row.difficulty_average - row.display_difficulty, 2))
      : '0';
  const bench = row.benchmark_difficulty;
  return {
    uuid: row.uuid,
    boardType,
    layoutId,
    setter_username: row.setter_username ?? '',
    userId: row.user_id ?? null,
    name: row.name ?? '',
    description: row.description ?? '',
    frames: row.frames ?? '',
    angle,
    ascensionist_count: Number(row.ascensionist_count ?? 0),
    difficulty: getGradeLabel(difficultyId),
    quality_average: row.quality_average !== null ? String(roundTo(row.quality_average, 2)) : '0',
    stars: getClimbStars(row.quality_average),
    difficulty_error: difficultyError,
    benchmark_difficulty: bench !== null && bench > 0 ? String(bench) : null,
    is_draft: !!row.is_draft,
    is_hidden: !!row.is_hidden,
    is_no_match: isNoMatch(characteristics),
    characteristics,
    published_at: row.published_at,
    created_at: row.created_at,
    userAscents: Number(row.user_ascents ?? 0),
    userAttempts: Number(row.user_attempts ?? 0),
    framesCount: row.frames_count ?? null,
    framesPace: row.frames_pace ?? null,
    // Boardsesh grade (COALESCE(universal, local)) + confidence tier for this
    // angle. Null when no board_climb_grades row is joined (MoonBoard, too few
    // ascents); the UI keeps the Aurora grade then, exactly like the server.
    boardseshDifficulty: row.boardsesh_difficulty ?? null,
    boardseshConfidence: row.boardsesh_confidence ?? null,
    // The sizes this climb fits on, so an offline queue add is judged the same
    // way an online one is — on Woods this is the only signal that separates the
    // 8x10 from the 12x12 (canAddClimbToBoard rule 5).
    compatibleSizeIds: parseCompatibleSizeIds(row.compatible_size_ids),
    // The climber's own grade, so a row that was filtered and ordered by it
    // arrives holding it. Key omitted entirely when the search did not ask for
    // personal grades, matching the server row shape.
    ...(hasPersonalGrade ? { myDifficulty: row.my_difficulty ?? null } : {}),
  };
}

export async function searchClimbsLocal(db: OfflineDatabase, input: ClimbSearchInput): Promise<LocalSearchResult> {
  // One indexed sync_meta read per search. See `ownedTicks`.
  const ownerUserId = await getLocalUserId(db);
  const boardType = input.boardName;
  const angle = input.angle;
  const page = Math.max(0, Math.trunc(input.page ?? 0));
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortBy = normalizeSortBy(input.sortBy);
  const sortOrder = input.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const useMyGrades = usesMyGrades(input);

  const { joinSql, whereSql, joinBinds, whereBinds } = buildJoinAndWhere(input, ownerUserId);

  // SELECT-clause binds come first textually: the two per-climb tick counts
  // (board, angle, owner each), then the optional popular-total subquery, then
  // the optional personal-grade probe. Positional `?` binds, so this list has to
  // stay in the same order the fragments appear in the SQL text below.
  const selectBinds: Bind[] = [boardType, angle, ownerUserId, boardType, angle, ownerUserId];
  const popularSelect =
    sortBy === 'popular'
      ? `, (SELECT COALESCE(SUM(ps.ascensionist_count), 0) FROM board_climb_stats ps
          WHERE ps.climb_uuid = c.uuid AND ps.board_type = ?) AS popular_total`
      : '';
  if (sortBy === 'popular') selectBinds.push(boardType);

  // Project the climber's own grade so the row carries the number it was
  // filtered and ordered by, exactly like the server's join projection.
  const myGradeSelect = useMyGrades ? `, ${MY_GRADE_SUBQUERY} AS my_difficulty` : '';
  if (useMyGrades) selectBinds.push(...myGradeBinds(boardType, angle, ownerUserId));

  const userAscentsSelect = `(SELECT COUNT(*) FROM boardsesh_ticks t
    WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND ${ownedTicks('t')}
    AND t.status IN ${COMPLETED_STATUSES}) AS user_ascents`;
  const userAttemptsSelect = `(SELECT COUNT(*) FROM boardsesh_ticks t
    WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND ${ownedTicks('t')}
    AND t.status = 'attempt') AS user_attempts`;

  // Random uses the seeded mixer (order direction is meaningless); every other
  // sort uses its column + direction. Both keep the c.uuid DESC secondary tiebreak.
  const isRandom = sortBy === 'random';
  // Number('') is 0 (not NaN), so guard on the raw string too — an empty/absent
  // seed falls back to 1 rather than silently pinning every shuffle to seed 0.
  const seedInt = Number(input.sortSeed);
  const randomSeedBind = input.sortSeed && Number.isFinite(seedInt) ? Math.trunc(seedInt) : 1;
  const orderBy = isRandom
    ? `${RANDOM_ORDER_EXPR} ASC, c.uuid DESC`
    : `${sortColumnSql(sortBy, useMyGrades)} ${sortOrder}, c.uuid DESC`;

  const query = `
    SELECT
      c.uuid, c.setter_username, c.user_id, c.name, c.description, c.frames, c.is_draft, c.is_hidden,
      c.characteristics,
      c.created_at, c.published_at, c.frames_count, c.frames_pace, c.compatible_size_ids,
      s.ascensionist_count, s.display_difficulty, s.difficulty_average, s.quality_average,
      s.benchmark_difficulty,
      COALESCE(g.universal_grade, g.local_grade) AS boardsesh_difficulty,
      g.confidence AS boardsesh_confidence,
      ${userAscentsSelect},
      ${userAttemptsSelect}${popularSelect}${myGradeSelect}
    FROM board_climbs c
    ${joinSql}
    WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  // ORDER BY sits between WHERE and LIMIT/OFFSET in the SQL text, and carries
  // the random seed `?` for a shuffle. The difficulty sort needs no binds of
  // its own: it reads the `my_difficulty` alias the SELECT already computed,
  // rather than repeating that subquery and its three binds here.
  const orderBinds: Bind[] = isRandom ? [randomSeedBind] : [];
  const binds: Bind[] = [...selectBinds, ...joinBinds, ...whereBinds, ...orderBinds, pageSize + 1, page * pageSize];
  const rows = await db.getAllAsync<LocalClimbRow>(query, binds);

  const hasMore = rows.length > pageSize;
  const trimmed = hasMore ? rows.slice(0, pageSize) : rows;
  const climbs = trimmed.map((row) => mapRowToClimb(row, boardType, input.layoutId, angle, useMyGrades));
  return { climbs, hasMore };
}

export async function countClimbsLocal(db: OfflineDatabase, input: ClimbSearchInput): Promise<number> {
  const ownerUserId = await getLocalUserId(db);
  const { joinSql, whereSql, joinBinds, whereBinds } = buildJoinAndWhere(input, ownerUserId);
  const query = `
    SELECT COUNT(*) AS total
    FROM board_climbs c
    ${joinSql}
    WHERE ${whereSql}
  `;
  const row = await db.getFirstAsync<{ total: number }>(query, [...joinBinds, ...whereBinds]);
  return row?.total ?? 0;
}
