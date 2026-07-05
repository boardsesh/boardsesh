import type { SQLiteDatabase } from 'expo-sqlite';
import type { Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import { isNoMatch } from '@boardsesh/shared-schema';
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

type Bind = string | number;

const DEFAULT_PAGE_SIZE = 20;

const SORT_ALIASES: Record<string, string> = {
  ascents: 'ascents',
  difficulty: 'difficulty',
  name: 'name',
  quality: 'quality',
  popular: 'popular',
  creation: 'creation',
  created_at: 'creation',
  published_at: 'creation',
};

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
      const holdId = Number(String(keyRaw).replace('hold_', ''));
      if (!Number.isInteger(holdId) || holdId <= 0 || !entry || typeof entry !== 'object') continue;
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
  // ascents/rating, present-hold, and personal-progress filters are all supported.
  // These need tables we don't sync (or the drafts owner path), so fall back:
  if (input.onlyDrafts) return false;
  if (input.onlyTallClimbs || input.onlyWideClimbs || input.onlyWithBetaVideos) return false;
  if (input.zoneBox) return false;
  const { hasHoldState } = parseHoldsFilter(input.holdsFilter);
  if (hasHoldState) return false;
  return true;
}

// Per-status tick-count / existence fragments, all scoped to (climb, board, angle).
const COMPLETED_STATUSES = "('flash', 'send')";
function ticksExists(negated: boolean, statusSql: string): string {
  return `${negated ? 'NOT EXISTS' : 'EXISTS'} (SELECT 1 FROM boardsesh_ticks t
    WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND ${statusSql})`;
}

type JoinAndWhere = { joinSql: string; whereSql: string; joinBinds: Bind[]; whereBinds: Bind[] };

function buildJoinAndWhere(input: ClimbSearchInput): JoinAndWhere {
  const boardType = input.boardName;
  const angle = input.angle;
  const setIds = parseSetIds(input.setIds);
  const isMoonboard = boardType === 'moonboard';

  const joinBinds: Bind[] = [boardType, angle];
  const joinSql = `LEFT JOIN board_climb_stats s
    ON s.climb_uuid = c.uuid AND s.board_type = ? AND s.angle = ?`;

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

  // Boulders / routes on frames_count (NULL is legacy single-frame → boulder).
  const wantsBoulders = !!input.boulders;
  const wantsRoutes = !!input.routes;
  if (wantsBoulders && !wantsRoutes) {
    push('(c.frames_count = 1 OR c.frames_count IS NULL)');
  } else if (wantsRoutes && !wantsBoulders) {
    push('c.frames_count > 1');
  }

  // Size: compatible_size_ids contains sizeId (skip for moonboard's single size).
  if (!isMoonboard) {
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

  // Grade range on the rounded display difficulty (integer grade ids).
  const roundedGrade = 'CAST(ROUND(s.display_difficulty) AS INTEGER)';
  if (input.minGrade && input.maxGrade) {
    push(`${roundedGrade} BETWEEN ? AND ?`, input.minGrade, input.maxGrade);
  } else if (input.minGrade) {
    push(`${roundedGrade} >= ?`, input.minGrade);
  } else if (input.maxGrade) {
    push(`${roundedGrade} <= ?`, input.maxGrade);
  }

  // Min rating (quality_average is canonical 1-5).
  if (input.minRating) {
    push('s.quality_average >= ?', input.minRating);
  }

  // Grade accuracy: |rounded display - difficulty_average| <= accuracy.
  const gradeAccuracy = input.gradeAccuracy ? parseFloat(input.gradeAccuracy) : NaN;
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

  // Personal progress against local ticks (device is single-user).
  if (input.hideAttempted) push(ticksExists(true, "t.status = 'attempt'"), boardType, angle);
  if (input.hideCompleted) push(ticksExists(true, `t.status IN ${COMPLETED_STATUSES}`), boardType, angle);
  if (input.showOnlyAttempted) push(ticksExists(false, "t.status = 'attempt'"), boardType, angle);
  if (input.showOnlyCompleted) push(ticksExists(false, `t.status IN ${COMPLETED_STATUSES}`), boardType, angle);

  return { joinSql, whereSql: conditions.join(' AND '), joinBinds, whereBinds };
}

function sortColumnSql(sortBy: string): string {
  switch (sortBy) {
    case 'ascents':
      return 's.ascensionist_count';
    case 'difficulty':
      return 'CAST(ROUND(s.display_difficulty) AS INTEGER)';
    case 'name':
      return 'c.name';
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
  /** Selected by the detail read; absent (undefined) for search rows. */
  description?: string | null;
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

export function mapRowToClimb(row: LocalClimbRow, boardType: string, layoutId: number, angle: number): Climb {
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
    frames: row.frames ?? '',
    angle,
    ascensionist_count: Number(row.ascensionist_count ?? 0),
    difficulty: getGradeLabel(difficultyId),
    quality_average: row.quality_average !== null ? String(roundTo(row.quality_average, 2)) : '0',
    stars: getClimbStars(row.quality_average),
    difficulty_error: difficultyError,
    benchmark_difficulty: bench !== null && bench > 0 ? String(bench) : null,
    is_draft: !!row.is_draft,
    is_no_match: isNoMatch(characteristics),
    characteristics,
    published_at: row.published_at,
    created_at: row.created_at,
    userAscents: Number(row.user_ascents ?? 0),
    userAttempts: Number(row.user_attempts ?? 0),
    framesCount: row.frames_count ?? null,
    framesPace: row.frames_pace ?? null,
  };
}

export async function searchClimbsLocal(db: SQLiteDatabase, input: ClimbSearchInput): Promise<LocalSearchResult> {
  const boardType = input.boardName;
  const angle = input.angle;
  const page = Math.max(0, Math.trunc(input.page ?? 0));
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const sortBy = normalizeSortBy(input.sortBy);
  const sortOrder = input.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const { joinSql, whereSql, joinBinds, whereBinds } = buildJoinAndWhere(input);

  // SELECT-clause binds come first textually: the two per-climb tick counts, then
  // the optional popular-total subquery.
  const selectBinds: Bind[] = [boardType, angle, boardType, angle];
  const popularSelect =
    sortBy === 'popular'
      ? `, (SELECT COALESCE(SUM(ps.ascensionist_count), 0) FROM board_climb_stats ps
          WHERE ps.climb_uuid = c.uuid AND ps.board_type = ?) AS popular_total`
      : '';
  if (sortBy === 'popular') selectBinds.push(boardType);

  const userAscentsSelect = `(SELECT COUNT(*) FROM boardsesh_ticks t
    WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND t.status IN ${COMPLETED_STATUSES}) AS user_ascents`;
  const userAttemptsSelect = `(SELECT COUNT(*) FROM boardsesh_ticks t
    WHERE t.climb_uuid = c.uuid AND t.board_type = ? AND t.angle = ? AND t.status = 'attempt') AS user_attempts`;

  const orderBy = `${sortColumnSql(sortBy)} ${sortOrder}, c.uuid DESC`;

  const query = `
    SELECT
      c.uuid, c.setter_username, c.user_id, c.name, c.frames, c.is_draft, c.characteristics,
      c.created_at, c.published_at, c.frames_count, c.frames_pace,
      s.ascensionist_count, s.display_difficulty, s.difficulty_average, s.quality_average,
      s.benchmark_difficulty,
      ${userAscentsSelect},
      ${userAttemptsSelect}${popularSelect}
    FROM board_climbs c
    ${joinSql}
    WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const binds: Bind[] = [...selectBinds, ...joinBinds, ...whereBinds, pageSize + 1, page * pageSize];
  const rows = await db.getAllAsync<LocalClimbRow>(query, binds);

  const hasMore = rows.length > pageSize;
  const trimmed = hasMore ? rows.slice(0, pageSize) : rows;
  const climbs = trimmed.map((row) => mapRowToClimb(row, boardType, input.layoutId, angle));
  return { climbs, hasMore };
}

export async function countClimbsLocal(db: SQLiteDatabase, input: ClimbSearchInput): Promise<number> {
  const { joinSql, whereSql, joinBinds, whereBinds } = buildJoinAndWhere(input);
  const query = `
    SELECT COUNT(*) AS total
    FROM board_climbs c
    ${joinSql}
    WHERE ${whereSql}
  `;
  const row = await db.getFirstAsync<{ total: number }>(query, [...joinBinds, ...whereBinds]);
  return row?.total ?? 0;
}
