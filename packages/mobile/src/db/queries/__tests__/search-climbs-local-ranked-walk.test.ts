// The ranked walk in `searchClimbsLocal`: the default sort read off
// `idx_stats_ascents` instead of filtering and sorting the whole board per page.
//
// Two things are pinned here. The rows: whichever reader answers, a page holds
// what the full ordering puts on it, checked against an order worked out in JS
// from the fixtures (never against the other SQL reader, which could be wrong in
// the same way). And the cost: which searches take the walk, that it stops at
// its budget, and that SQLite serves it from the index without a sort.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { ensureMutationQueueTable, runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';
import type { OfflineDatabase, SqlExecutor, SqlRunResult, SqlValue } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { searchClimbsLocal } from '../search-climbs-local';

const LOCAL_OWNER = 'me';
const PAGE_SIZE = 20;

function makeInput(overrides: Partial<ClimbSearchInput> = {}): ClimbSearchInput {
  return {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 5,
    setIds: '1,20',
    angle: 40,
    page: 0,
    pageSize: PAGE_SIZE,
    sortBy: 'ascents',
    sortOrder: 'desc',
    boulders: true,
    routes: true,
    ...overrides,
  } as ClimbSearchInput;
}

async function openDatabase(): Promise<TestSqliteDb> {
  const db = createTestDatabase();
  await ensureMutationQueueTable(db);
  await runMigrations(db);
  await stampLocalUserId(db, LOCAL_OWNER);
  return db;
}

type CapturedQuery = { sql: string; binds: SqlValue[] };

/** Delegates to a real database and keeps every read it was asked for. */
class RecordingDatabase implements OfflineDatabase {
  readonly captured: CapturedQuery[] = [];

  constructor(private readonly inner: TestSqliteDb) {}

  private record(source: string, params: (SqlValue | SqlValue[])[]): void {
    const binds = params.length === 1 && Array.isArray(params[0]) ? params[0] : (params as SqlValue[]);
    this.captured.push({ sql: source, binds });
  }

  execAsync(source: string): Promise<void> {
    return this.inner.execAsync(source);
  }

  runAsync(source: string, ...params: (SqlValue | SqlValue[])[]): Promise<SqlRunResult> {
    return this.inner.runAsync(source, ...(params as SqlValue[]));
  }

  getFirstAsync<T>(source: string, ...params: (SqlValue | SqlValue[])[]): Promise<T | null> {
    this.record(source, params);
    return this.inner.getFirstAsync<T>(source, ...(params as SqlValue[]));
  }

  getAllAsync<T>(source: string, ...params: (SqlValue | SqlValue[])[]): Promise<T[]> {
    this.record(source, params);
    return this.inner.getAllAsync<T>(source, ...(params as SqlValue[]));
  }

  withExclusiveTransactionAsync(task: (txn: SqlExecutor) => Promise<void>): Promise<void> {
    return this.inner.withExclusiveTransactionAsync(task);
  }
}

/** The walk's page read: the statement that drives from the stats index and joins climbs. */
const isWalkRead = (query: CapturedQuery) =>
  query.sql.includes('INDEXED BY idx_stats_ascents') && query.sql.includes('CROSS JOIN board_climbs c');
/** The walk's budget probe: the index-only read of the row the walk stops before. */
const isEdgeProbe = (query: CapturedQuery) =>
  query.sql.includes('INDEXED BY idx_stats_ascents') && !query.sql.includes('board_climbs');
/** The full query: every listed climb on the board, filtered and sorted. */
const isFullRead = (query: CapturedQuery) => query.sql.includes('FROM board_climbs c');
/** The layout's size, which caps the walk's budget. */
const isLayoutCount = (query: CapturedQuery) => query.sql.includes('COUNT(*) AS total FROM board_climbs');

type Readers = { walk: number; full: number };
type SearchRun = Awaited<ReturnType<typeof searchClimbsLocal>> & {
  uuids: string[];
  readers: Readers;
  captured: CapturedQuery[];
};

async function search(db: TestSqliteDb, input: ClimbSearchInput): Promise<SearchRun> {
  // A fresh recorder is a fresh connection as far as the search is concerned,
  // so no test inherits another's cached layout size.
  const recorder = new RecordingDatabase(db);
  const result = await searchClimbsLocal(recorder, input);
  return {
    ...result,
    uuids: result.climbs.map((climb) => climb.uuid),
    readers: {
      walk: recorder.captured.filter(isWalkRead).length,
      full: recorder.captured.filter(isFullRead).length,
    },
    captured: recorder.captured,
  };
}

async function readEveryPage(db: TestSqliteDb, overrides: Partial<ClimbSearchInput> = {}) {
  const uuids: string[] = [];
  const readersByPage: Readers[] = [];
  for (let page = 0; page < 60; page++) {
    const result = await search(db, makeInput({ ...overrides, page }));
    uuids.push(...result.uuids);
    readersByPage.push(result.readers);
    if (!result.hasMore) return { uuids, readersByPage };
    expect(result.uuids).toHaveLength(PAGE_SIZE);
  }
  throw new Error('the list never ended');
}

type SeedClimb = {
  uuid: string;
  boardType?: string;
  /** `null`: a stats row whose count is NULL. `undefined`: no stats row at the browsed angle. */
  ascents?: number | null;
  displayDifficulty?: number;
  listed?: boolean;
  sizeIds?: number[] | null;
  setIds?: number[] | null;
  layoutId?: number;
  framesCount?: number;
  /** The angle the climb was set at (`board_climbs.angle`). */
  setAngle?: number | null;
  statsAngle?: number;
};

async function seed(db: TestSqliteDb, climbs: SeedClimb[]): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const climb of climbs) {
      const boardType = climb.boardType ?? 'kilter';
      await txn.runAsync(
        `INSERT INTO board_climbs
          (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, frames_count, frames,
           compatible_size_ids, required_set_ids, setter_username, angle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, '', ?, ?, 'setter', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        [
          climb.uuid,
          boardType,
          climb.layoutId ?? 1,
          `Climb ${climb.uuid}`,
          climb.listed === false ? 0 : 1,
          climb.framesCount ?? 1,
          climb.sizeIds === null ? null : JSON.stringify(climb.sizeIds ?? [5]),
          climb.setIds === null ? null : JSON.stringify(climb.setIds ?? [1, 20]),
          climb.setAngle ?? null,
        ],
      );
      if (climb.ascents !== undefined) {
        await txn.runAsync(
          `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, updated_at)
           VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
          [boardType, climb.uuid, climb.statsAngle ?? 40, climb.displayDifficulty ?? 16, climb.ascents],
        );
      }
    }
  });
}

async function insertTick(
  db: TestSqliteDb,
  tick: { climbUuid: string; status: string; difficulty?: number; quality?: number },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, quality, difficulty, is_benchmark, climbed_at, created_at, updated_at)
     VALUES (?, ?, 'kilter', ?, 40, 0, ?, 1, ?, ?, 0, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
    [
      `tick-${tick.climbUuid}-${tick.status}`,
      LOCAL_OWNER,
      tick.climbUuid,
      tick.status,
      tick.quality ?? null,
      tick.difficulty ?? null,
    ],
  );
}

async function insertGrade(
  db: TestSqliteDb,
  grade: { climbUuid: string; universalGrade: number; confidence: string },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_grades (board_type, climb_uuid, angle, universal_grade, confidence, computed_at, sync_seq)
     VALUES ('kilter', ?, 40, ?, ?, '2026-01-01T00:00:00Z', 1)`,
    [grade.climbUuid, grade.universalGrade, grade.confidence],
  );
}

const byRank = (left: SeedClimb, right: SeedClimb) => {
  const rank = (climb: SeedClimb) => (climb.ascents == null ? -1 : climb.ascents);
  return rank(right) - rank(left) || (left.uuid < right.uuid ? 1 : left.uuid > right.uuid ? -1 : 0);
};

/** The order the full query defines: most ascents first, zero next, no count last, ties by uuid descending. */
function expectedOrder(climbs: SeedClimb[], keep: (climb: SeedClimb) => boolean = () => true): string[] {
  return climbs
    .filter(
      (climb) =>
        climb.listed !== false &&
        (climb.boardType ?? 'kilter') === 'kilter' &&
        (climb.layoutId ?? 1) === 1 &&
        (climb.sizeIds ?? [5]).includes(5) &&
        keep(climb),
    )
    .sort(byRank)
    .map((climb) => climb.uuid);
}

const counted = (index: number) => `counted-${String(index).padStart(3, '0')}`;
const isCounted = (climb: SeedClimb) => climb.uuid.startsWith('counted-');
/** `counted-NNN`'s upstream grade in `mixedBoard`. */
const gradeOf = (climb: SeedClimb) => 10 + (Number(climb.uuid.slice('counted-'.length)) % 12);

/**
 * 150 climbs with a count at 40 degrees: 135 somebody has sent (many ties), 15
 * at zero. Then the rest of what the index does not hold: a NULL count, no stats
 * row at all. Plus rows every search must skip: unlisted, another layout,
 * another size, another board type. The 1,600 climbs of another size make the
 * layout big enough to be worth walking (the budget is an eighth of it: 225
 * ranks), as a real one is.
 */
function mixedBoard(): SeedClimb[] {
  const climbs: SeedClimb[] = [];
  for (let index = 0; index < 150; index++) {
    // Seven-way ties, so the uuid tie-break decides most neighbours; every tenth is 0.
    const ascents = index % 10 === 0 ? 0 : 500 - Math.floor(index / 7) * 3;
    climbs.push({
      uuid: counted(index),
      ascents,
      displayDifficulty: 10 + (index % 12),
      framesCount: index % 9 === 0 ? 2 : 1,
    });
  }
  for (let index = 0; index < 12; index++) climbs.push({ uuid: `null-count-${index}`, ascents: null });
  for (let index = 0; index < 25; index++) climbs.push({ uuid: `no-stats-${String(index).padStart(2, '0')}` });
  for (let index = 0; index < 10; index++) {
    climbs.push({ uuid: `unlisted-${index}`, ascents: 900 + index, listed: false });
    climbs.push({ uuid: `other-layout-${index}`, ascents: 800 + index, layoutId: 8 });
    climbs.push({ uuid: `other-size-${index}`, ascents: 700 + index, sizeIds: [7] });
    climbs.push({ uuid: `other-board-${index}`, ascents: 950 + index, boardType: 'tension' });
  }
  for (let index = 0; index < 1600; index++) climbs.push({ uuid: `bulk-other-size-${index}`, sizeIds: [7] });
  return climbs;
}

describe('searchClimbsLocal: the ranked walk returns the full ordering', () => {
  let db: TestSqliteDb;
  let climbs: SeedClimb[];

  beforeEach(async () => {
    db = await openDatabase();
    climbs = mixedBoard();
    await seed(db, climbs);
  });

  it('pages through sent climbs, then the unsent tail, in one unbroken order', async () => {
    const { uuids, readersByPage } = await readEveryPage(db);

    expect(uuids).toEqual(expectedOrder(climbs));
    expect(uuids).toHaveLength(187);
    // 135 sent climbs: pages 0..5 (rows 0..119 plus the look-ahead row) come
    // off the index alone. Page 6 would need row 140, past the last sent climb,
    // so it and everything after it is the full query's: the zero-ascent
    // climbs, then the ones with no count at all.
    expect(readersByPage.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => ({ walk: 1, full: 0 })));
    expect(readersByPage.slice(6)).toEqual(Array.from({ length: 4 }, () => ({ walk: 1, full: 1 })));
  });

  it('keeps the order under a grade band, a minimum ascent count and boulders only', async () => {
    const gradeBand = await readEveryPage(db, { minGrade: 12, maxGrade: 17 });
    expect(gradeBand.uuids).toEqual(
      expectedOrder(
        climbs,
        // No stats row: no grade to be in the band. A NULL count keeps its grade.
        (climb) =>
          climb.ascents !== undefined && (climb.displayDifficulty ?? 16) >= 12 && (climb.displayDifficulty ?? 16) <= 17,
      ),
    );
    expect(gradeBand.readersByPage[0]).toEqual({ walk: 1, full: 0 });

    const minAscents = await readEveryPage(db, { minAscents: 450 });
    expect(minAscents.uuids).toEqual(expectedOrder(climbs, (climb) => (climb.ascents ?? 0) >= 450));
    expect(minAscents.readersByPage[0]).toEqual({ walk: 1, full: 0 });

    const bouldersOnly = await readEveryPage(db, { boulders: true, routes: false });
    expect(bouldersOnly.uuids).toEqual(expectedOrder(climbs, (climb) => (climb.framesCount ?? 1) === 1));
    expect(bouldersOnly.readersByPage[0]).toEqual({ walk: 1, full: 0 });
  });

  it('hides sent and tried climbs, and carries the tick counts on its rows', async () => {
    const sent = new Set([counted(1), counted(2), counted(15), counted(149), 'no-stats-03']);
    const tried = new Set([counted(3), counted(15)]);
    for (const climbUuid of sent) await insertTick(db, { climbUuid, status: 'send' });
    for (const climbUuid of tried) await insertTick(db, { climbUuid, status: 'attempt' });

    const hideSent = await readEveryPage(db, { hideCompleted: true });
    expect(hideSent.uuids).toEqual(expectedOrder(climbs, (climb) => !sent.has(climb.uuid)));
    expect(hideSent.readersByPage[0]).toEqual({ walk: 1, full: 0 });

    const hideBoth = await readEveryPage(db, { hideCompleted: true, hideAttempted: true });
    expect(hideBoth.uuids).toEqual(expectedOrder(climbs, (climb) => !sent.has(climb.uuid) && !tried.has(climb.uuid)));
    expect(hideBoth.readersByPage[0]).toEqual({ walk: 1, full: 0 });

    const firstPage = await search(db, makeInput());
    expect(firstPage.readers).toEqual({ walk: 1, full: 0 });
    const row = (uuid: string) => firstPage.climbs.find((climb) => climb.uuid === uuid);
    expect([row(counted(1))?.userAscents, row(counted(1))?.userAttempts]).toEqual([1, 0]);
    expect([row(counted(3))?.userAscents, row(counted(3))?.userAttempts]).toEqual([0, 1]);
    expect([row(counted(15))?.userAscents, row(counted(15))?.userAttempts]).toEqual([1, 1]);
    expect([row(counted(4))?.userAscents, row(counted(4))?.userAttempts]).toEqual([0, 0]);
  });

  it('filters on the climber’s own grade and returns it on the row (#4828)', async () => {
    // counted-001 is an 11 the climber calls 20; counted-008 is an 18 they call 12.
    await insertTick(db, { climbUuid: counted(1), status: 'send', difficulty: 20 });
    await insertTick(db, { climbUuid: counted(8), status: 'send', difficulty: 12 });
    const inBand = (grade: number) => grade >= 18 && grade <= 21;

    const personal = await readEveryPage(db, { useMyGrades: true, minGrade: 18, maxGrade: 21 });
    expect(personal.uuids).toEqual(
      expectedOrder(
        climbs,
        (climb) =>
          isCounted(climb) && (climb.uuid === counted(1) || (climb.uuid !== counted(8) && inBand(gradeOf(climb)))),
      ),
    );
    expect(personal.readersByPage[0]).toEqual({ walk: 1, full: 0 });
    expect(personal.uuids).toContain(counted(1));
    expect(personal.uuids).not.toContain(counted(8));

    // Without personal grades the same band keeps the crowd's answer.
    const crowd = await readEveryPage(db, { minGrade: 18, maxGrade: 21 });
    expect(crowd.uuids).toEqual(expectedOrder(climbs, (climb) => isCounted(climb) && inBand(gradeOf(climb))));

    const firstPage = await search(db, makeInput({ useMyGrades: true, minGrade: 18, maxGrade: 21 }));
    expect(firstPage.readers).toEqual({ walk: 1, full: 0 });
    expect(firstPage.climbs.find((climb) => climb.uuid === counted(1))?.myDifficulty).toBe(20);
    expect(firstPage.climbs.find((climb) => climb.uuid === counted(9))?.myDifficulty).toBeNull();
  });

  it('follows the grade source, and returns the Boardsesh grade on the row', async () => {
    // counted-001: upstream 11, Boardsesh 19. counted-008: upstream 18, Boardsesh
    // 12. counted-009: upstream 19, with a setter-only 12 that is never shown.
    await insertGrade(db, { climbUuid: counted(1), universalGrade: 19, confidence: 'confirmed' });
    await insertGrade(db, { climbUuid: counted(8), universalGrade: 12, confidence: 'confirmed' });
    await insertGrade(db, { climbUuid: counted(9), universalGrade: 12, confidence: 'setter_only' });
    const inBand = (grade: number) => grade >= 18 && grade <= 21;

    const boardsesh = await readEveryPage(db, { gradeSource: 'BOARDSESH', minGrade: 18, maxGrade: 21 });
    expect(boardsesh.uuids).toEqual(
      expectedOrder(
        climbs,
        (climb) =>
          isCounted(climb) && (climb.uuid === counted(1) || (climb.uuid !== counted(8) && inBand(gradeOf(climb)))),
      ),
    );
    expect(boardsesh.readersByPage[0]).toEqual({ walk: 1, full: 0 });
    expect(boardsesh.uuids).toContain(counted(9));

    const upstream = await readEveryPage(db, { minGrade: 18, maxGrade: 21 });
    expect(upstream.uuids).toEqual(expectedOrder(climbs, (climb) => isCounted(climb) && inBand(gradeOf(climb))));

    const firstPage = await search(db, makeInput());
    const row = (uuid: string) => firstPage.climbs.find((climb) => climb.uuid === uuid);
    expect([row(counted(1))?.boardseshDifficulty, row(counted(1))?.boardseshConfidence]).toEqual([19, 'confirmed']);
    expect([row(counted(2))?.boardseshDifficulty, row(counted(2))?.boardseshConfidence]).toEqual([null, null]);
  });

  it('keeps climbs the climber rated at or above the minimum, and the ones they never rated', async () => {
    await insertTick(db, { climbUuid: counted(1), status: 'send', quality: 2 });
    await insertTick(db, { climbUuid: counted(2), status: 'send', quality: 4 });

    const result = await readEveryPage(db, { minUserRating: 3 });

    expect(result.uuids).toEqual(expectedOrder(climbs, (climb) => climb.uuid !== counted(1)));
    expect(result.readersByPage[0]).toEqual({ walk: 1, full: 0 });
  });

  it('ignores a stats row with no climb, and one under another board type for the same uuid', async () => {
    await db.execAsync(`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count) VALUES
        ('kilter', 'no-such-climb', 40, 16, 99999),
        ('tension', '${counted(5)}', 40, 16, 88888);
    `);

    const { uuids } = await readEveryPage(db);

    expect(uuids).toEqual(expectedOrder(climbs));
    expect(uuids.filter((uuid) => uuid === counted(5))).toHaveLength(1);
  });

  it('answers a short list from the full query, with nothing skipped or repeated', async () => {
    const result = await search(db, makeInput({ minGrade: 10, maxGrade: 10 }));

    // Thirteen climbs are graded 10: fewer than a page, so the full query's.
    expect(result.uuids).toEqual(expectedOrder(climbs, (climb) => isCounted(climb) && gradeOf(climb) === 10));
    expect(result.uuids).toHaveLength(13);
    expect(result.hasMore).toBe(false);
    expect(result.readers).toEqual({ walk: 1, full: 1 });
  });

  it('leaves an angle nobody has climbed at to the full query', async () => {
    const result = await search(db, makeInput({ angle: 70 }));

    // No stats at 70 degrees: every climb is unsent there, so the order is uuid alone.
    expect(result.uuids).toEqual(
      expectedOrder(climbs.map((climb) => ({ ...climb, ascents: undefined }))).slice(0, PAGE_SIZE),
    );
    expect(result.readers).toEqual({ walk: 1, full: 1 });
  });
});

describe('searchClimbsLocal: the ranked walk on boards with their own rules', () => {
  it('walks a MoonBoard list, which has no size filter and allows a climb with no required sets', async () => {
    const db = await openDatabase();
    const climbs: SeedClimb[] = [];
    for (let index = 0; index < 60; index++) {
      climbs.push({
        uuid: `moon-${String(index).padStart(2, '0')}`,
        boardType: 'moonboard',
        ascents: 100 + (index % 9),
        sizeIds: null,
        setIds: index % 4 === 0 ? null : index % 4 === 1 ? [3] : [1, 2],
      });
    }
    for (let index = 0; index < 400; index++) {
      climbs.push({ uuid: `moon-unsent-${index}`, boardType: 'moonboard', sizeIds: null, setIds: [3] });
    }
    await seed(db, climbs);

    const result = await search(db, makeInput({ boardName: 'moonboard', sizeId: 1, setIds: '1,2' }));

    const expected = climbs
      .filter((climb) => climb.ascents !== undefined && (climb.setIds === null || !climb.setIds?.includes(3)))
      .sort(byRank)
      .map((climb) => climb.uuid);
    expect(expected).toHaveLength(45);
    expect(result.uuids).toEqual(expected.slice(0, PAGE_SIZE));
    expect(result.hasMore).toBe(true);
    expect(result.readers).toEqual({ walk: 1, full: 0 });
  });

  it('walks a Woods list at the browsed angle, where a climb belongs to the angle it was set at', async () => {
    const db = await openDatabase();
    const climbs: SeedClimb[] = [];
    for (let index = 0; index < 40; index++) {
      climbs.push({
        uuid: `woods-here-${String(index).padStart(2, '0')}`,
        boardType: 'woods',
        ascents: 50 + (index % 5),
        setAngle: 30,
        statsAngle: 30,
        setIds: [],
      });
    }
    // Set and climbed at 45 only: no stats row at 30, so not on the walk, and
    // not in the browsed-angle list either.
    for (let index = 0; index < 400; index++) {
      climbs.push({
        uuid: `woods-elsewhere-${index}`,
        boardType: 'woods',
        ascents: 900,
        setAngle: 45,
        statsAngle: 45,
        setIds: [],
      });
    }
    await seed(db, climbs);

    const result = await search(db, makeInput({ boardName: 'woods', sizeId: 5, setIds: '', angle: 30 }));

    const expected = climbs
      .filter((climb) => climb.setAngle === 30)
      .sort(byRank)
      .map((climb) => climb.uuid);
    expect(result.uuids).toEqual(expected.slice(0, PAGE_SIZE));
    expect(result.hasMore).toBe(true);
    expect(result.readers).toEqual({ walk: 1, full: 0 });
  });
});

describe('searchClimbsLocal: which searches take the ranked walk', () => {
  let db: TestSqliteDb;

  beforeAll(async () => {
    db = await openDatabase();
    await seed(db, mixedBoard());
  });

  it.each<[string, Partial<ClimbSearchInput>]>([
    ['ascending ascents', { sortOrder: 'asc' }],
    ['the quality sort', { sortBy: 'quality' }],
    ['the difficulty sort', { sortBy: 'difficulty' }],
    ['the popular sort', { sortBy: 'popular' }],
    ['the newest sort', { sortBy: 'creation' }],
    ['a shuffle', { sortBy: 'random', sortSeed: '7' }],
    ['cross-angle stats', { crossAngleStats: true }],
    ['a name search', { name: 'Climb' }],
    ['a setter filter', { setter: ['setter'] }],
    ['projects only', { projectsOnly: true }],
    ['benchmarks only', { onlyBenchmarks: true }],
    ['only climbs I sent', { showOnlyCompleted: true }],
    ['only climbs I tried', { showOnlyAttempted: true }],
    ['only climbs I rated', { onlyRatedByMe: true }],
    ['a hold filter', { holdsFilter: { hold_1100: { ANY: 'include' } } }],
    ['an excluded hold', { holdsFilter: { hold_1100: { ANY: 'exclude' } } }],
  ])('never walks for %s', async (_label, overrides) => {
    const result = await search(db, makeInput(overrides));

    expect(result.captured.filter((query) => query.sql.includes('idx_stats_ascents'))).toEqual([]);
    expect(result.captured.filter(isLayoutCount)).toEqual([]);
    expect(result.readers.full).toBe(1);
  });

  it.each<[string, Partial<ClimbSearchInput>]>([
    ['the default list', {}],
    ['an omitted sort', { sortBy: undefined, sortOrder: undefined }],
    ['a grade band', { minGrade: 10, maxGrade: 21 }],
    ['a minimum ascent count', { minAscents: 1 }],
    ['hiding sends and attempts', { hideCompleted: true, hideAttempted: true }],
    ['personal grades', { useMyGrades: true, minGrade: 10, maxGrade: 21 }],
    ['the Boardsesh grade source', { gradeSource: 'BOARDSESH', minGrade: 10, maxGrade: 21 }],
    ['a minimum personal rating', { minUserRating: 3 }],
  ])('walks for %s', async (_label, overrides) => {
    const result = await search(db, makeInput(overrides));

    expect(result.uuids).toHaveLength(PAGE_SIZE);
    expect(result.hasMore).toBe(true);
    expect(result.readers).toEqual({ walk: 1, full: 0 });
  });
});

describe('searchClimbsLocal: the ranked walk is bounded and index-served', () => {
  // 120,000 climbs in tie groups of 14: rank r (0 = most climbed) is group
  // r / 14 with count 20,000 - group, and within a group the higher uuid ranks
  // first. An eighth of the layout is 15,000 ranks.
  const RANKED = 120_000;
  const GROUP = 14;
  const rankUuid = (rank: number) =>
    `r-${String(Math.floor(rank / GROUP)).padStart(5, '0')}-${String(GROUP - 1 - (rank % GROUP)).padStart(2, '0')}`;
  const ranks = (from: number, count: number) =>
    Array.from({ length: count }, (_unused, index) => rankUuid(from + index));

  let db: TestSqliteDb;

  beforeAll(async () => {
    db = await openDatabase();
    // Grades mark the climbs each test asks for:
    //  30: ranks 12,030..12,089, all past the 12,000-rank budget.
    //  25: ranks 100..139.
    //  27: ranks 200..218 and the whole tie group the 12,000 edge falls in
    //      (ranks 11,998..12,011; the edge is its third member).
    await db.execAsync(`
      WITH RECURSIVE ranks(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM ranks WHERE r < ${RANKED - 1})
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, frames_count, frames,
         compatible_size_ids, required_set_ids, setter_username, created_at, updated_at)
      SELECT printf('r-%05d-%02d', r / ${GROUP}, ${GROUP - 1} - (r % ${GROUP})), 'kilter', 1, printf('Rank %d', r), 1, 0, 0, 1, '',
         '[5]', '[1,20]', 'setter', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      FROM ranks;
    `);
    await db.execAsync(`
      WITH RECURSIVE ranks(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM ranks WHERE r < ${RANKED - 1})
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, updated_at)
      SELECT 'kilter', printf('r-%05d-%02d', r / ${GROUP}, ${GROUP - 1} - (r % ${GROUP})), 40,
         CASE WHEN r BETWEEN 12030 AND 12089 THEN 30
              WHEN r BETWEEN 100 AND 139 THEN 25
              WHEN r BETWEEN 200 AND 218 OR r BETWEEN 11998 AND 12011 THEN 27
              ELSE 16 END,
         20000 - r / ${GROUP}, '2026-01-01T00:00:00Z'
      FROM ranks;
    `);
  }, 60_000);

  it('stops at its budget and lets the full query answer when the matches lie beyond it', async () => {
    const result = await search(db, makeInput({ minGrade: 30, maxGrade: 30 }));

    // The walk read ranks 0..11,999, found nothing, and gave up; it did not go
    // on to rank 12,030. The rows are right because the full query supplied them.
    expect(result.readers).toEqual({ walk: 1, full: 1 });
    expect(result.uuids).toEqual(ranks(12_030, PAGE_SIZE));
    expect(result.hasMore).toBe(true);

    expect(result.captured.find(isEdgeProbe)?.binds).toEqual(['kilter', 40, 12_000]);
    const walk = result.captured.find(isWalkRead);
    expect(walk?.sql).toContain('(s.ascensionist_count, s.climb_uuid) > (?, ?)');
    // The row at rank 12,000 is the first one the walk does not read.
    expect(walk?.binds).toEqual(expect.arrayContaining([20_000 - Math.floor(12_000 / GROUP), rankUuid(12_000)]));
  });

  it('cuts a tie group at the edge on the uuid, keeping the ranks before it and none after', async () => {
    // Nineteen matches early on, then the edge's own tie group: ranks 11,998 and
    // 11,999 are inside the budget, 12,000..12,011 are not. Twenty-one matches
    // inside, so the walk answers, and its last row and look-ahead are the two
    // members ranked above the edge. A bound that kept the members below it
    // instead would also fill the page, with rank 12,001 in place of 11,998.
    const result = await search(db, makeInput({ minGrade: 27, maxGrade: 27 }));

    expect(result.readers).toEqual({ walk: 1, full: 0 });
    expect(result.uuids).toEqual([...ranks(200, 19), rankUuid(11_998)]);
    expect(result.hasMore).toBe(true);

    // One page on, only rank 11,999 is left inside the budget: the full query's.
    const next = await search(db, makeInput({ minGrade: 27, maxGrade: 27, page: 1 }));
    expect(next.readers).toEqual({ walk: 1, full: 1 });
    expect(next.uuids).toEqual(ranks(11_999, 13));
    expect(next.hasMore).toBe(false);
  });

  it('answers from the walk when the page fills inside the budget', async () => {
    const first = await search(db, makeInput({ minGrade: 25, maxGrade: 25 }));
    expect(first.readers).toEqual({ walk: 1, full: 0 });
    expect(first.uuids).toEqual(ranks(100, PAGE_SIZE));
    expect(first.hasMore).toBe(true);

    // The second page needs 41 matches and only 40 exist: the full query's.
    const second = await search(db, makeInput({ minGrade: 25, maxGrade: 25, page: 1 }));
    expect(second.readers).toEqual({ walk: 1, full: 1 });
    expect(second.uuids).toEqual(ranks(120, PAGE_SIZE));
    expect(second.hasMore).toBe(false);
  });

  it('widens the budget with the depth of the page, up to an eighth of the layout', async () => {
    const shallow = await search(db, makeInput({ page: 3 }));
    expect(shallow.captured.find(isEdgeProbe)?.binds).toEqual(['kilter', 40, 12_000]);
    expect(shallow.uuids[0]).toBe(rankUuid(60));

    // Page 24 wants rows 480..500: 501 rows, 25 stats rows each.
    const deeper = await search(db, makeInput({ page: 24 }));
    expect(deeper.captured.find(isEdgeProbe)?.binds).toEqual(['kilter', 40, 12_525]);
    expect(deeper.readers).toEqual({ walk: 1, full: 0 });
    expect(deeper.uuids[0]).toBe(rankUuid(480));

    // Page 40 would get 20,525 by depth; an eighth of 120,000 climbs is 15,000.
    const capped = await search(db, makeInput({ page: 40 }));
    expect(capped.captured.find(isEdgeProbe)?.binds).toEqual(['kilter', 40, 15_000]);
    expect(capped.readers).toEqual({ walk: 1, full: 0 });
    expect(capped.uuids[0]).toBe(rankUuid(800));
  });

  it('does not start a walk that could not fill the page inside its budget', async () => {
    // Row 15,000 and the twenty after it: more rows than the 15,000 ranks allowed.
    const result = await search(db, makeInput({ page: 750 }));

    expect(result.captured.filter((query) => query.sql.includes('idx_stats_ascents'))).toEqual([]);
    expect(result.readers).toEqual({ walk: 0, full: 1 });
    expect(result.uuids).toEqual(ranks(15_000, PAGE_SIZE));
  });

  it('remembers a walk that came up short, and does not repeat it deeper in the same search', async () => {
    const recorder = new RecordingDatabase(db);
    const walksSoFar = () => recorder.captured.filter(isWalkRead).length;
    const hardOnly = { minGrade: 30, maxGrade: 30 };

    // Page 0 walks its budget and misses.
    const first = await searchClimbsLocal(recorder, makeInput(hardOnly));
    expect(walksSoFar()).toBe(1);
    expect(first.climbs.map((climb) => climb.uuid)).toEqual(ranks(12_030, PAGE_SIZE));

    // Pages 1 and 2 of the same search go straight to the full query.
    const second = await searchClimbsLocal(recorder, makeInput({ ...hardOnly, page: 1 }));
    const third = await searchClimbsLocal(recorder, makeInput({ ...hardOnly, page: 2 }));
    expect(walksSoFar()).toBe(1);
    expect(second.climbs.map((climb) => climb.uuid)).toEqual(ranks(12_050, PAGE_SIZE));
    expect(third.climbs.map((climb) => climb.uuid)).toEqual(ranks(12_070, PAGE_SIZE));
    expect(third.hasMore).toBe(false);

    // Another search is not held back by it, and neither is a shallower page of
    // one that missed deeper down.
    await searchClimbsLocal(recorder, makeInput({ minGrade: 25, maxGrade: 25, page: 1 }));
    expect(walksSoFar()).toBe(2);
    await searchClimbsLocal(recorder, makeInput({ minGrade: 25, maxGrade: 25 }));
    expect(walksSoFar()).toBe(3);
    await searchClimbsLocal(recorder, makeInput({ minGrade: 25, maxGrade: 25, page: 1 }));
    expect(walksSoFar()).toBe(3);

    // A minute later the search gets one more try.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    try {
      await searchClimbsLocal(recorder, makeInput({ ...hardOnly, page: 1 }));
      expect(walksSoFar()).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  it('counts the layout once per connection, not once per page', async () => {
    const recorder = new RecordingDatabase(db);
    await searchClimbsLocal(recorder, makeInput());
    await searchClimbsLocal(recorder, makeInput({ page: 1 }));
    await searchClimbsLocal(recorder, makeInput({ page: 2, minGrade: 25, maxGrade: 25 }));

    const layoutCounts = recorder.captured.filter(isLayoutCount);
    expect(layoutCounts).toHaveLength(1);
    expect(layoutCounts[0].binds).toEqual(['kilter', 1]);
  });

  it('is served by the index: no sort, climbs by primary key, the probe and the count from an index alone', async () => {
    const result = await search(db, makeInput({ page: 2, hideCompleted: true }));
    expect(result.readers).toEqual({ walk: 1, full: 0 });

    const explain = async (query: CapturedQuery | undefined): Promise<string[]> => {
      if (!query) throw new Error('the statement was never sent');
      const rows = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql}`, query.binds);
      return rows.map((row) => row.detail);
    };

    const walkPlan = await explain(result.captured.find(isWalkRead));
    expect(walkPlan[0]).toMatch(/^SEARCH s USING INDEX idx_stats_ascents \(board_type=\? AND angle=\? AND /);
    expect(walkPlan).toContain('SEARCH c USING INDEX sqlite_autoindex_board_climbs_1 (uuid=?)');
    expect(walkPlan.filter((detail) => detail.includes('TEMP B-TREE'))).toEqual([]);
    // Nothing reads a whole table: every access below the driving index is a keyed SEARCH.
    expect(walkPlan.filter((detail) => /^SCAN (?!json_each)/.test(detail))).toEqual([]);

    const probePlan = await explain(result.captured.find(isEdgeProbe));
    expect(probePlan).toHaveLength(1);
    expect(probePlan[0]).toMatch(/^SEARCH board_climb_stats USING COVERING INDEX idx_stats_ascents /);

    expect(await explain(result.captured.find(isLayoutCount))).toEqual([
      'SEARCH board_climbs USING COVERING INDEX idx_climbs_search (board_type=? AND layout_id=? AND is_listed=?)',
    ]);
  });
});

describe('searchClimbsLocal: a small layout gets a small budget', () => {
  it('walks an eighth of the layout and no further, however many ranks the board type has', async () => {
    const db = await openDatabase();
    // 400 listed climbs in this layout, ranked below 5,000 climbs of another
    // layout of the same board type: the shared ranking is long, but the full
    // query for this layout only ever visits 400 climbs.
    await db.execAsync(`
      WITH RECURSIVE ranks(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM ranks WHERE r < 5399)
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, frames_count, frames,
         compatible_size_ids, required_set_ids, setter_username, created_at, updated_at)
      SELECT printf('c-%05d', r), 'kilter', CASE WHEN r < 5000 THEN 8 ELSE 1 END, printf('Rank %d', r), 1, 0, 0, 1, '',
         '[5]', '[1,20]', 'setter', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      FROM ranks;
    `);
    await db.execAsync(`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, updated_at)
      SELECT 'kilter', uuid, 40, 16, 20000 - CAST(substr(uuid, 3) AS INTEGER), '2026-01-01T00:00:00Z' FROM board_climbs;
    `);

    const result = await search(db, makeInput());

    // An eighth of 400 is 50 ranks, all of them the other layout's: nothing
    // found, at the cost of 50 rows and not 5,000.
    expect(result.captured.find(isEdgeProbe)?.binds).toEqual(['kilter', 40, 50]);
    expect(result.readers).toEqual({ walk: 1, full: 1 });
    expect(result.uuids).toEqual(
      Array.from({ length: PAGE_SIZE }, (_unused, index) => `c-${String(5000 + index).padStart(5, '0')}`),
    );
  });
});
