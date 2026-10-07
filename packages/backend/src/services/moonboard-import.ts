import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { v5 as uuidv5 } from 'uuid';
import { MOONBOARD_GRADES, MOONBOARD_LAYOUTS } from '@boardsesh/board-config';
import { boardseshTicks } from '@boardsesh/db/schema';
import { recomputeClimbStatsBulk, rowsOf, type ClimbStatsKey } from '@boardsesh/db/queries';
import {
  DEFAULT_MOONBOARD_IMPORT_ANGLE,
  MOONBOARD_CLIMB_MATCH_METHODS,
  classifyMoonBoardLogRow,
  type MoonBoardClimbMatchMethod,
  type MoonBoardExportLogRow,
  type MoonBoardImportProgressEvent,
  type MoonBoardImportResult,
  type StrippedMoonBoardExportData,
} from '@boardsesh/shared-schema';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

type ClassifiedMoonBoardLogRow = {
  row: MoonBoardExportLogRow;
  /** Set for rows with a name: the key into the batched name lookup. */
  nameLookupKey?: string;
  angle: number;
  climbedAt: string;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  difficulty: number;
};

type ResolvedMoonBoardLogRow = {
  row: MoonBoardExportLogRow;
  climbUuid: string;
  angle: number;
  climbedAt: string;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  difficulty: number;
  quality: number | null;
};

type MoonBoardResolutionRow = {
  candidateUuid: string;
  canonicalUuid: string | null;
  climbAngle: number | string | null;
  displayDifficulty: number | string | null;
};

type MoonBoardNameMatchRow = {
  lookupKey: string;
  canonicalUuid: string;
  exactName: boolean;
  setterUsername: string | null;
  displayDifficulty: number | string | null;
};

export type MoonBoardNameCandidate = {
  climbUuid: string;
  /** False when only the `?` wildcard pattern matched this climb's name. */
  exactName: boolean;
  setter: string | null;
  difficultyId: number | null;
};

export type MoonBoardClimbMatch = {
  climbUuid: string;
  method: MoonBoardClimbMatchMethod;
};

type MoonBoardNameLookup = {
  lookupKey: string;
  name: string;
  layoutId: number | null;
  angle: number;
};

type ExistingTickRow = {
  climbUuid: string;
  angle: number | string;
  climbedOn: string;
};

type PendingInsertRow = {
  source: ResolvedMoonBoardLogRow;
  insert: {
    uuid: string;
    userId: string;
    boardType: 'moonboard';
    climbUuid: string;
    angle: number;
    isMirror: false;
    origin: 'moonboard_import';
    status: 'flash' | 'send' | 'attempt';
    attemptCount: number;
    quality: number | null;
    difficulty: number;
    isBenchmark: boolean;
    comment: string;
    climbedAt: string;
  };
};

const MOONBOARD_CLIMB_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
// Moon only exports logs from its 25° and 40° boards.
const MOONBOARD_IMPORT_ANGLES = new Set([25, 40]);
const INSERT_BATCH_SIZE = 100;
const GRADE_TO_DIFFICULTY_ID = new Map<string, number>(
  MOONBOARD_GRADES.flatMap((grade) => [
    [grade.value.toUpperCase(), grade.difficultyId],
    [grade.label.split('/')[0].toUpperCase(), grade.difficultyId],
  ]),
);

// Grades the MoonBoard picker no longer offers but an older export can still
// carry; keep them importable on the shared ids the catalog importer uses.
GRADE_TO_DIFFICULTY_ID.set('5A', 13);
GRADE_TO_DIFFICULTY_ID.set('5B', 14);
GRADE_TO_DIFFICULTY_ID.set('5C', 15);
// Moon's 25° 2024 problems export their easiest grade as a bare "5"; the
// catalogue stores those climbs at the same difficulty as 5+.
GRADE_TO_DIFFICULTY_ID.set('5', 13);

export function moonBoardGradeToDifficultyId(grade: string): number | undefined {
  return GRADE_TO_DIFFICULTY_ID.get(grade.trim().toUpperCase());
}

function normalizeLayoutName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const LAYOUT_ID_BY_SETUP_NAME = new Map<string, number>(
  Object.values(MOONBOARD_LAYOUTS).map((layout) => [normalizeLayoutName(layout.name), layout.id]),
);

/** Maps Moon's "Setup" column ("MoonBoard 2016", "MoonBoard Masters 2017") to our layout id. */
export function moonBoardLayoutIdForSetup(setup: string): number | undefined {
  return LAYOUT_ID_BY_SETUP_NAME.get(normalizeLayoutName(setup));
}

// Applied to both the export's names and the catalogue's, so case, padding and
// curly-vs-straight apostrophes don't stop a match.
function normalizeProblemName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase();
}

// translate() swaps each curly quote for a straight one ('''''' is two straight
// apostrophes inside a SQL literal); \\s survives the template literal as \s.
const NORMALIZED_CLIMB_NAME_SQL = sql`lower(regexp_replace(translate(btrim(board_climbs.name), '\u2018\u2019', ''''''), '\\s+', ' ', 'g'))`;

function deterministicUuid(name: string): string {
  return uuidv5(name, MOONBOARD_CLIMB_UUID_NAMESPACE);
}

function candidateClimbUuids(problemId: number, angle: number): string[] {
  return [deterministicUuid(`moonboard:${problemId}`), deterministicUuid(`moonboard:${problemId}:${angle}`)];
}

function parseMoonBoardDate(date: string): string | null {
  const match = date.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  if (utcDate.getUTCFullYear() !== year || utcDate.getUTCMonth() !== month - 1 || utcDate.getUTCDate() !== day) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} 12:00:00`;
}

function importTickUuid(userId: string, row: ResolvedMoonBoardLogRow): string {
  // Id-based 40° rows keep the key earlier imports used, so re-importing an old
  // export stays a no-op.
  const climbIdentity = row.row.problemId ?? row.climbUuid;
  const keyParts: (string | number)[] = [
    'moonboard-import',
    userId,
    climbIdentity,
    row.row.grade,
    row.climbedAt,
    row.status,
    row.attemptCount,
  ];
  if (row.angle !== DEFAULT_MOONBOARD_IMPORT_ANGLE) keyParts.push(row.angle);
  return deterministicUuid(keyParts.join(':'));
}

function unresolvedLabel(row: MoonBoardExportLogRow): string {
  return row.problemId != null ? String(row.problemId) : (row.name ?? `line ${row.lineNumber}`);
}

function compareUnresolvedLabels(first: string, second: string): number {
  return first.localeCompare(second, 'en', { numeric: true, sensitivity: 'base' });
}

function resultCounts(): MoonBoardImportResult {
  return {
    ticks: { imported: 0, skipped: 0, failed: 0 },
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
    unresolvedAscentClimbs: [],
    unresolvedAttemptClimbs: [],
    matchedBy: Object.fromEntries(MOONBOARD_CLIMB_MATCH_METHODS.map((method) => [method, 0])) as Record<
      MoonBoardClimbMatchMethod,
      number
    >,
  };
}

function pushUnique(items: string[], item: string): void {
  if (!items.includes(item)) items.push(item);
}

function climbedOn(row: Pick<ResolvedMoonBoardLogRow, 'climbedAt'>): string {
  return row.climbedAt.slice(0, 10);
}

function existingTickDateKey(row: Pick<ResolvedMoonBoardLogRow, 'climbUuid' | 'angle' | 'climbedAt'>): string {
  return `${row.climbUuid}:${row.angle}:${climbedOn(row)}`;
}

function importTickKey(
  row: Pick<ResolvedMoonBoardLogRow, 'climbUuid' | 'angle' | 'climbedAt' | 'status' | 'attemptCount'>,
): string {
  return `${row.climbUuid}:${row.angle}:${row.climbedAt}:${row.status}:${row.attemptCount}`;
}

async function resolveClimbUuidById(
  db: DrizzleDb,
  problemId: number,
  angle: number,
  difficultyId: number,
): Promise<string | null> {
  const candidates = candidateClimbUuids(problemId, angle);
  const candidateSql = sql.join(
    candidates.map((candidateUuid, index) => sql`(${candidateUuid}, ${index + 1})`),
    sql`, `,
  );
  const resolutionResult = await db.execute<MoonBoardResolutionRow>(sql`
    WITH candidate_input(candidate_uuid, ordinal) AS (
      VALUES ${candidateSql}
    )
    SELECT
      candidate_input.candidate_uuid AS "candidateUuid",
      COALESCE(board_climb_aliases.canonical_uuid, board_climbs.uuid) AS "canonicalUuid",
      board_climbs.angle AS "climbAngle",
      board_climb_stats.display_difficulty AS "displayDifficulty"
    FROM candidate_input
    LEFT JOIN board_climb_aliases
      ON board_climb_aliases.board_type = 'moonboard'
     AND board_climb_aliases.alias_uuid = candidate_input.candidate_uuid
    LEFT JOIN board_climbs
      ON board_climbs.board_type = 'moonboard'
     AND board_climbs.uuid = COALESCE(board_climb_aliases.canonical_uuid, candidate_input.candidate_uuid)
    LEFT JOIN board_climb_stats
      ON board_climb_stats.board_type = 'moonboard'
     AND board_climb_stats.climb_uuid = board_climbs.uuid
     AND board_climb_stats.angle = ${angle}
    ORDER BY candidate_input.ordinal
  `);

  for (const candidate of rowsOf<MoonBoardResolutionRow>(resolutionResult)) {
    if (!candidate.canonicalUuid) continue;
    const climbAngle = candidate.climbAngle == null ? null : Number(candidate.climbAngle);
    if (climbAngle != null && climbAngle !== angle) continue;
    if (Number(candidate.displayDifficulty) !== difficultyId) continue;
    return candidate.canonicalUuid;
  }

  return null;
}

function nameLookupKey(name: string, layoutId: number | null, angle: number): string {
  return `${layoutId ?? '*'}:${angle}:${normalizeProblemName(name)}`;
}

// Moon's export writes every character Windows-1252 can't hold as "?", so
// "紙一重 -KAMI HITOE-" arrives as "??? -KAMI HITOE-" and "鏡花水月" as "????".
// Each "?" therefore stands for exactly one character that Windows-1252 can't
// encode (or a literal "?"), never an ordinary letter: "????" can match "鏡花水月"
// but not "WU 2". Windows-1252 holds ASCII, U+00A0-U+00FF and these 27 extras.
const WINDOWS_1252_EXTRA_CHARACTERS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const LOST_CHARACTER_PATTERN = `(\\?|[^\u0001-\u007F\u00A0-\u00FF${WINDOWS_1252_EXTRA_CHARACTERS}])`;

/**
 * Anchored Postgres regex for a name with "?" placeholders, or null when it has
 * none. Every other character must match literally.
 */
export function lossyNamePattern(normalizedName: string): string | null {
  if (!normalizedName.includes('?')) return null;
  const slots = [...normalizedName].map((character) =>
    character === '?' ? LOST_CHARACTER_PATTERN : character.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&'),
  );
  return `^${slots.join('')}$`;
}

async function queryNameCandidates(
  db: DrizzleDb,
  lookups: MoonBoardNameLookup[],
  mode: 'exact' | 'pattern',
): Promise<MoonBoardNameMatchRow[]> {
  if (lookups.length === 0) return [];

  const lookupSql = sql.join(
    lookups.map((lookup) => {
      const normalizedName = normalizeProblemName(lookup.name);
      const lookupValue = mode === 'pattern' ? lossyNamePattern(normalizedName) : normalizedName;
      return sql`(${lookup.lookupKey}::text, ${normalizedName}::text, ${lookupValue}::text, ${lookup.layoutId}::integer, ${lookup.angle}::integer)`;
    }),
    sql`, `,
  );
  // Kept as two queries so the exact batch can hash-join on the name; a regex
  // in the same join would force a nested loop over every row in the file.
  const nameCondition =
    mode === 'exact'
      ? sql`${NORMALIZED_CLIMB_NAME_SQL} = name_input.lookup_value`
      : sql`${NORMALIZED_CLIMB_NAME_SQL} ~ name_input.lookup_value`;
  const matchResult = await db.execute<MoonBoardNameMatchRow>(sql`
    WITH name_input(lookup_key, lookup_name, lookup_value, layout_id, angle) AS (
      VALUES ${lookupSql}
    )
    SELECT DISTINCT
      name_input.lookup_key AS "lookupKey",
      COALESCE(board_climb_aliases.canonical_uuid, board_climbs.uuid) AS "canonicalUuid",
      ${NORMALIZED_CLIMB_NAME_SQL} = name_input.lookup_name AS "exactName",
      board_climbs.setter_username AS "setterUsername",
      board_climb_stats.display_difficulty AS "displayDifficulty"
    FROM name_input
    JOIN board_climbs
      ON board_climbs.board_type = 'moonboard'
     AND ${nameCondition}
     AND (name_input.layout_id IS NULL OR board_climbs.layout_id = name_input.layout_id)
     AND (board_climbs.angle IS NULL OR board_climbs.angle = name_input.angle)
    LEFT JOIN board_climb_aliases
      ON board_climb_aliases.board_type = 'moonboard'
     AND board_climb_aliases.alias_uuid = board_climbs.uuid
    LEFT JOIN board_climb_stats
      ON board_climb_stats.board_type = 'moonboard'
     AND board_climb_stats.climb_uuid = COALESCE(board_climb_aliases.canonical_uuid, board_climbs.uuid)
     AND board_climb_stats.angle = name_input.angle
  `);
  return rowsOf<MoonBoardNameMatchRow>(matchResult);
}

/**
 * Loads every catalogue climb that shares a row's name, at the row's angle and
 * within its layout when the export names one.
 */
async function findNameCandidates(
  db: DrizzleDb,
  lookups: MoonBoardNameLookup[],
): Promise<Map<string, MoonBoardNameCandidate[]>> {
  const lossyLookups = lookups.filter((lookup) => lossyNamePattern(normalizeProblemName(lookup.name)) != null);
  const lossyKeys = new Set(lossyLookups.map((lookup) => lookup.lookupKey));
  const exactLookups = lookups.filter((lookup) => !lossyLookups.includes(lookup));
  const matches = [
    ...(await queryNameCandidates(db, exactLookups, 'exact')),
    ...(await queryNameCandidates(db, lossyLookups, 'pattern')),
  ];

  const candidatesByKey = new Map<string, MoonBoardNameCandidate[]>();
  for (const match of matches) {
    const candidates = candidatesByKey.get(match.lookupKey) ?? [];
    candidates.push({
      climbUuid: match.canonicalUuid,
      // A name with "?" may be one the export mangled, so even a literal match
      // (a catalogue climb really named "????") isn't trusted on name alone.
      exactName: match.exactName && !lossyKeys.has(match.lookupKey),
      setter: match.setterUsername,
      difficultyId: match.displayDifficulty == null ? null : Number(match.displayDifficulty),
    });
    candidatesByKey.set(match.lookupKey, candidates);
  }
  return candidatesByKey;
}

function normalizeSetterName(setter: string): string {
  return setter.trim().replace(/\s+/g, ' ').toLowerCase();
}

type NameMatchStrategy = {
  method: Exclude<MoonBoardClimbMatchMethod, 'id'>;
  /** Null when the row lacks the data this strategy needs. */
  accepts: (row: { setter?: string; difficultyId: number }) => ((candidate: MoonBoardNameCandidate) => boolean) | null;
};

// Most specific first. A strategy only wins when exactly one climb passes it, so
// "12 Monkeys" set twice by the same setter still needs the grade to pick one.
// The name-only fallback never trusts a wildcard match: without the grade,
// "wu ??" would happily pick "WU #1".
const NAME_MATCH_STRATEGIES: readonly NameMatchStrategy[] = [
  {
    method: 'nameSetterGrade',
    accepts: ({ setter, difficultyId }) => {
      if (!setter) return null;
      const normalizedSetter = normalizeSetterName(setter);
      return (candidate) =>
        candidate.difficultyId === difficultyId &&
        candidate.setter != null &&
        normalizeSetterName(candidate.setter) === normalizedSetter;
    },
  },
  {
    method: 'nameGrade',
    accepts:
      ({ difficultyId }) =>
      (candidate) =>
        candidate.difficultyId === difficultyId,
  },
  {
    method: 'name',
    accepts: () => (candidate) => candidate.exactName,
  },
];

/** Picks the climb a name-matched row refers to, or null when it stays ambiguous. */
export function pickClimbByName(
  candidates: readonly MoonBoardNameCandidate[],
  row: { setter?: string; difficultyId: number },
): MoonBoardClimbMatch | null {
  for (const strategy of NAME_MATCH_STRATEGIES) {
    const accepts = strategy.accepts(row);
    if (!accepts) continue;
    const climbUuids = new Set(candidates.filter(accepts).map((candidate) => candidate.climbUuid));
    if (climbUuids.size === 1) return { climbUuid: [...climbUuids][0], method: strategy.method };
  }
  return null;
}

async function findExistingTickKeys(
  db: DrizzleDb,
  userId: string,
  rows: ResolvedMoonBoardLogRow[],
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();

  const climbUuids = [...new Set(rows.map((row) => row.climbUuid))];
  const climbedOnValues = [...new Set(rows.map((row) => climbedOn(row)))];
  const angleValues = [...new Set(rows.map((row) => row.angle))];
  const climbUuidArraySql = sql.join(
    climbUuids.map((climbUuid) => sql`${climbUuid}`),
    sql`, `,
  );
  const climbedOnArraySql = sql.join(
    climbedOnValues.map((climbedOnValue) => sql`${climbedOnValue}`),
    sql`, `,
  );
  const angleArraySql = sql.join(
    angleValues.map((angle) => sql`${angle}`),
    sql`, `,
  );
  const existingResult = await db.execute<ExistingTickRow>(sql`
    SELECT
      COALESCE(board_climb_aliases.canonical_uuid, boardsesh_ticks.climb_uuid) AS "climbUuid",
      boardsesh_ticks.angle AS "angle",
      to_char(boardsesh_ticks.climbed_at::date, 'YYYY-MM-DD') AS "climbedOn"
    FROM boardsesh_ticks
    LEFT JOIN board_climb_aliases
      ON board_climb_aliases.board_type = boardsesh_ticks.board_type
     AND board_climb_aliases.alias_uuid = boardsesh_ticks.climb_uuid
    WHERE boardsesh_ticks.user_id = ${userId}
      AND boardsesh_ticks.board_type = 'moonboard'
      AND boardsesh_ticks.angle = ANY(ARRAY[${angleArraySql}]::integer[])
      AND COALESCE(board_climb_aliases.canonical_uuid, boardsesh_ticks.climb_uuid) = ANY(ARRAY[${climbUuidArraySql}]::text[])
      AND boardsesh_ticks.climbed_at::date = ANY(ARRAY[${climbedOnArraySql}]::date[])
  `);

  return new Set(
    rowsOf<ExistingTickRow>(existingResult).map((row) => `${row.climbUuid}:${Number(row.angle)}:${row.climbedOn}`),
  );
}

function countSkippedResult(result: MoonBoardImportResult, row: ResolvedMoonBoardLogRow): void {
  result.ticks.skipped += 1;
  if (row.status === 'attempt') {
    result.attempts.skipped += 1;
  } else {
    result.ascents.skipped += 1;
  }
}

function countImportedResult(result: MoonBoardImportResult, row: ResolvedMoonBoardLogRow): void {
  result.ticks.imported += 1;
  if (row.status === 'attempt') {
    result.attempts.imported += 1;
  } else {
    result.ascents.imported += 1;
  }
}

function countFailedResult(
  result: MoonBoardImportResult,
  row: MoonBoardExportLogRow,
  classification?: { status: 'flash' | 'send' | 'attempt' },
): void {
  result.ticks.failed += 1;
  if (classification?.status === 'attempt') {
    result.attempts.failed += 1;
    pushUnique(result.unresolvedAttemptClimbs, unresolvedLabel(row));
  } else if (classification) {
    result.ascents.failed += 1;
    pushUnique(result.unresolvedAscentClimbs, unresolvedLabel(row));
  }
  pushUnique(result.unresolvedClimbs, unresolvedLabel(row));
}

export async function importMoonBoardExportData(
  db: DrizzleDb,
  userId: string,
  data: StrippedMoonBoardExportData,
  onEvent: (event: MoonBoardImportProgressEvent) => void,
): Promise<MoonBoardImportResult> {
  const result = resultCounts();
  const classifiedRows: ClassifiedMoonBoardLogRow[] = [];
  const nameLookups = new Map<string, MoonBoardNameLookup>();

  for (const row of data.logs) {
    let classification: { status: 'flash' | 'send' | 'attempt'; attemptCount: number };
    try {
      classification = classifyMoonBoardLogRow(row);
    } catch {
      countFailedResult(result, row);
      continue;
    }

    const difficultyId = moonBoardGradeToDifficultyId(row.grade);
    const climbedAt = parseMoonBoardDate(row.date);
    const angle = row.angle ?? DEFAULT_MOONBOARD_IMPORT_ANGLE;
    const layoutId = row.setup ? moonBoardLayoutIdForSetup(row.setup) : null;
    // An unknown setup only blocks name matching; an id still resolves.
    const canMatchByName = row.name != null && layoutId !== undefined;
    if (
      difficultyId == null ||
      climbedAt == null ||
      !MOONBOARD_IMPORT_ANGLES.has(angle) ||
      (row.problemId == null && !canMatchByName)
    ) {
      countFailedResult(result, row, classification);
      continue;
    }

    let lookupKey: string | undefined;
    if (row.name && layoutId !== undefined) {
      lookupKey = nameLookupKey(row.name, layoutId, angle);
      nameLookups.set(lookupKey, { lookupKey, name: row.name, layoutId, angle });
    }
    classifiedRows.push({
      row,
      nameLookupKey: lookupKey,
      angle,
      climbedAt,
      status: classification.status,
      attemptCount: classification.attemptCount,
      difficulty: difficultyId,
    });
  }

  const nameCandidates = await findNameCandidates(db, [...nameLookups.values()]);
  const resolvedRows: ResolvedMoonBoardLogRow[] = [];

  for (let rowIndex = 0; rowIndex < classifiedRows.length; rowIndex += 1) {
    const classifiedRow = classifiedRows[rowIndex];
    const { row, nameLookupKey: lookupKey, angle, difficulty } = classifiedRow;
    onEvent({ type: 'progress', step: 'resolving', current: rowIndex + 1, total: classifiedRows.length });

    let match: MoonBoardClimbMatch | null = null;
    if (row.problemId != null) {
      const climbUuid = await resolveClimbUuidById(db, row.problemId, angle, difficulty);
      if (climbUuid) match = { climbUuid, method: 'id' };
    }
    if (!match && lookupKey) {
      match = pickClimbByName(nameCandidates.get(lookupKey) ?? [], { setter: row.setter, difficultyId: difficulty });
    }
    if (!match) {
      countFailedResult(result, row, classifiedRow);
      continue;
    }
    const { climbUuid } = match;
    if (result.matchedBy) result.matchedBy[match.method] += 1;

    resolvedRows.push({
      row,
      angle,
      climbedAt: classifiedRow.climbedAt,
      status: classifiedRow.status,
      attemptCount: classifiedRow.attemptCount,
      difficulty,
      climbUuid,
      quality: classifiedRow.status === 'attempt' ? null : row.rating,
    });
  }

  const existingTickDateKeys = await findExistingTickKeys(db, userId, resolvedRows);
  const claimedImportTickKeys = new Set<string>();
  const recomputeKeys = new Map<string, ClimbStatsKey>();

  for (let start = 0; start < resolvedRows.length; start += INSERT_BATCH_SIZE) {
    const batch = resolvedRows.slice(start, start + INSERT_BATCH_SIZE);
    onEvent({
      type: 'progress',
      step: 'importing',
      current: Math.min(start + batch.length, resolvedRows.length),
      total: resolvedRows.length,
    });

    const rowsToInsert: PendingInsertRow[] = [];
    for (const row of batch) {
      if (existingTickDateKeys.has(existingTickDateKey(row))) {
        countSkippedResult(result, row);
        continue;
      }

      const rowImportKey = importTickKey(row);
      if (claimedImportTickKeys.has(rowImportKey)) {
        countSkippedResult(result, row);
        continue;
      }
      claimedImportTickKeys.add(rowImportKey);

      rowsToInsert.push({
        source: row,
        insert: {
          uuid: importTickUuid(userId, row),
          userId,
          boardType: 'moonboard',
          climbUuid: row.climbUuid,
          angle: row.angle,
          isMirror: false,
          origin: 'moonboard_import',
          status: row.status,
          attemptCount: row.attemptCount,
          quality: row.quality,
          difficulty: row.difficulty,
          isBenchmark: row.row.isBenchmark ?? false,
          comment: row.row.comment ?? '',
          climbedAt: row.climbedAt,
        },
      });
    }

    if (rowsToInsert.length === 0) continue;

    const insertedRows = await db
      .insert(boardseshTicks)
      .values(rowsToInsert.map((pendingRow) => pendingRow.insert))
      .onConflictDoNothing()
      .returning({
        uuid: boardseshTicks.uuid,
        climbUuid: boardseshTicks.climbUuid,
        angle: boardseshTicks.angle,
        status: boardseshTicks.status,
      });

    const uncountedInsertedIds = new Set(insertedRows.map((insertedRow) => insertedRow.uuid));

    for (const pendingRow of rowsToInsert) {
      if (!uncountedInsertedIds.has(pendingRow.insert.uuid)) {
        countSkippedResult(result, pendingRow.source);
        continue;
      }

      uncountedInsertedIds.delete(pendingRow.insert.uuid);
      countImportedResult(result, pendingRow.source);
      if (pendingRow.source.status !== 'attempt') {
        recomputeKeys.set(`${pendingRow.source.climbUuid}:${pendingRow.source.angle}`, {
          boardType: 'moonboard',
          climbUuid: pendingRow.source.climbUuid,
          angle: pendingRow.source.angle,
        });
      }
    }
  }

  const recomputeKeyList = [...recomputeKeys.values()];
  if (recomputeKeyList.length > 0) {
    onEvent({ type: 'progress', step: 'recomputing', message: String(recomputeKeyList.length) });
    await recomputeClimbStatsBulk(db, recomputeKeyList);
  }

  result.unresolvedClimbs.sort(compareUnresolvedLabels);
  result.unresolvedAscentClimbs.sort(compareUnresolvedLabels);
  result.unresolvedAttemptClimbs.sort(compareUnresolvedLabels);
  return result;
}
