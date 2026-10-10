// The ranked walk in `searchClimbsLocal`: the default sort read off
// `idx_stats_ascents` instead of filtering and sorting the whole board per page.
//
// Two things are pinned here. The rows: whichever reader answers, a page holds
// what the full ordering puts on it, checked against an order worked out in JS
// from the fixtures (never against the other SQL reader, which could be wrong in
// the same way). And the cost: which searches take the walk, that it stops at
// its budget, and that SQLite serves it from the index without a sort.

import { describe, it, expect, beforeEach } from 'vitest';
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
    ...overrides,
  } as ClimbSearchInput;
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

type Readers = { walk: number; full: number };

async function searchAndCount(
  db: TestSqliteDb,
  input: ClimbSearchInput,
): Promise<{ uuids: string[]; hasMore: boolean; readers: Readers; captured: CapturedQuery[] }> {
  const recorder = new RecordingDatabase(db);
  const result = await searchClimbsLocal(recorder, input);
  return {
    uuids: result.climbs.map((climb) => climb.uuid),
    hasMore: result.hasMore,
    readers: {
      walk: recorder.captured.filter(isWalkRead).length,
      full: recorder.captured.filter(isFullRead).length,
    },
    captured: recorder.captured,
  };
}

type SeedClimb = {
  uuid: string;
  /** `null`: a stats row whose count is NULL. `undefined`: no stats row at 40 degrees. */
  ascents?: number | null;
  displayDifficulty?: number;
  listed?: boolean;
  sizeIds?: number[];
  layoutId?: number;
  framesCount?: number;
};

async function seed(db: TestSqliteDb, climbs: SeedClimb[]): Promise<void> {
  for (const climb of climbs) {
    await db.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, frames_count, frames,
         compatible_size_ids, required_set_ids, setter_username, created_at, updated_at)
       VALUES (?, 'kilter', ?, ?, ?, 0, 0, ?, '', ?, '[1,20]', 'setter', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [
        climb.uuid,
        climb.layoutId ?? 1,
        `Climb ${climb.uuid}`,
        climb.listed === false ? 0 : 1,
        climb.framesCount ?? 1,
        JSON.stringify(climb.sizeIds ?? [5]),
      ],
    );
    if (climb.ascents !== undefined) {
      await db.runAsync(
        `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, updated_at)
         VALUES ('kilter', ?, 40, ?, ?, '2026-01-01T00:00:00Z')`,
        [climb.uuid, climb.displayDifficulty ?? 16, climb.ascents],
      );
    }
  }
}

/** The order the full query defines: most ascents first, zero next, no count last, ties by uuid descending. */
function expectedOrder(climbs: SeedClimb[], keep: (climb: SeedClimb) => boolean = () => true): string[] {
  const rank = (climb: SeedClimb) => (climb.ascents == null ? -1 : climb.ascents);
  return climbs
    .filter(
      (climb) =>
        climb.listed !== false && (climb.layoutId ?? 1) === 1 && (climb.sizeIds ?? [5]).includes(5) && keep(climb),
    )
    .sort((left, right) => rank(right) - rank(left) || (left.uuid < right.uuid ? 1 : left.uuid > right.uuid ? -1 : 0))
    .map((climb) => climb.uuid);
}

/**
 * 150 climbs with a count at 40 degrees: 135 somebody has sent (many ties), 15
 * at zero. Then the rest of what the index does not hold: a NULL count, no stats
 * row at all. Plus rows every search must skip: unlisted, another layout,
 * another size.
 */
function mixedBoard(): SeedClimb[] {
  const climbs: SeedClimb[] = [];
  for (let index = 0; index < 150; index++) {
    const uuid = `counted-${String(index).padStart(3, '0')}`;
    // Seven-way ties, so the uuid tie-break decides most neighbours; every tenth is 0.
    const ascents = index % 10 === 0 ? 0 : 500 - Math.floor(index / 7) * 3;
    climbs.push({ uuid, ascents, displayDifficulty: 10 + (index % 12), framesCount: index % 9 === 0 ? 2 : 1 });
  }
  for (let index = 0; index < 12; index++) climbs.push({ uuid: `null-count-${index}`, ascents: null });
  for (let index = 0; index < 25; index++) climbs.push({ uuid: `no-stats-${String(index).padStart(2, '0')}` });
  for (let index = 0; index < 10; index++) {
    climbs.push({ uuid: `unlisted-${index}`, ascents: 900 + index, listed: false });
    climbs.push({ uuid: `other-layout-${index}`, ascents: 800 + index, layoutId: 8 });
    climbs.push({ uuid: `other-size-${index}`, ascents: 700 + index, sizeIds: [7] });
  }
  return climbs;
}

describe('searchClimbsLocal: the ranked walk returns the full ordering', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await stampLocalUserId(db, LOCAL_OWNER);
  });

  async function readEveryPage(overrides: Partial<ClimbSearchInput> = {}) {
    const uuids: string[] = [];
    const readersByPage: Readers[] = [];
    for (let page = 0; page < 50; page++) {
      const result = await searchAndCount(db, makeInput({ ...overrides, page }));
      uuids.push(...result.uuids);
      readersByPage.push(result.readers);
      if (!result.hasMore) return { uuids, readersByPage };
      expect(result.uuids).toHaveLength(PAGE_SIZE);
    }
    throw new Error('the list never ended');
  }

  it('pages through sent climbs, then the unsent tail, in one unbroken order', async () => {
    const climbs = mixedBoard();
    await seed(db, climbs);

    const { uuids, readersByPage } = await readEveryPage({ boulders: true, routes: true });

    expect(uuids).toEqual(expectedOrder(climbs));
    expect(uuids).toHaveLength(187);
    // 135 sent climbs: pages 0..5 (rows 0..119 plus the look-ahead row) come
    // off the index alone. Page 6 would need row 140, past the last sent climb,
    // so it and everything after it is the full query's: the zero-ascent
    // climbs, then the ones with no count at all.
    expect(readersByPage.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => ({ walk: 1, full: 0 })));
    expect(readersByPage.slice(6)).toEqual(Array.from({ length: 4 }, () => ({ walk: 1, full: 1 })));
  });

  it('keeps the order under the filters that stay on the walk', async () => {
    const climbs = mixedBoard();
    await seed(db, climbs);

    const gradeBand = await readEveryPage({ minGrade: 12, maxGrade: 17, boulders: true, routes: true });
    expect(gradeBand.uuids).toEqual(
      expectedOrder(
        climbs,
        // No stats row: no grade to be in the band. A NULL count keeps its grade.
        (climb) =>
          climb.ascents !== undefined && (climb.displayDifficulty ?? 16) >= 12 && (climb.displayDifficulty ?? 16) <= 17,
      ),
    );
    expect(gradeBand.readersByPage[0]).toEqual({ walk: 1, full: 0 });

    const minAscents = await readEveryPage({ minAscents: 450, boulders: true, routes: true });
    expect(minAscents.uuids).toEqual(expectedOrder(climbs, (climb) => (climb.ascents ?? 0) >= 450));

    const bouldersOnly = await readEveryPage({ boulders: true, routes: false });
    expect(bouldersOnly.uuids).toEqual(expectedOrder(climbs, (climb) => (climb.framesCount ?? 1) === 1));
    expect(bouldersOnly.readersByPage[0]).toEqual({ walk: 1, full: 0 });
  });

  it('hides sent climbs on the walk exactly as the full query does', async () => {
    const climbs = mixedBoard();
    await seed(db, climbs);
    const sent = new Set(['counted-001', 'counted-002', 'counted-015', 'counted-149', 'no-stats-03']);
    for (const climbUuid of sent) {
      await db.runAsync(
        `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, is_benchmark, climbed_at, created_at, updated_at)
         VALUES (?, ?, 'kilter', ?, 40, 0, 'send', 1, 0, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
        [`tick-${climbUuid}`, LOCAL_OWNER, climbUuid],
      );
    }

    const hidden = await readEveryPage({ hideCompleted: true, boulders: true, routes: true });
    expect(hidden.uuids).toEqual(expectedOrder(climbs, (climb) => !sent.has(climb.uuid)));
    expect(hidden.readersByPage[0]).toEqual({ walk: 1, full: 0 });

    // The walk's rows carry the same per-climb tick counts the full query's do.
    const firstPage = await searchClimbsLocal(db, makeInput({ boulders: true, routes: true }));
    const sentRow = firstPage.climbs.find((climb) => climb.uuid === 'counted-001');
    expect(sentRow?.userAscents).toBe(1);
    expect(firstPage.climbs.find((climb) => climb.uuid === 'counted-003')?.userAscents).toBe(0);
  });

  it('answers a short list from the full query, with nothing skipped or repeated', async () => {
    const climbs: SeedClimb[] = [
      { uuid: 'a', ascents: 5 },
      { uuid: 'b', ascents: 5 },
      { uuid: 'c', ascents: 0 },
      { uuid: 'd' },
      { uuid: 'e', ascents: null },
    ];
    await seed(db, climbs);

    const result = await searchAndCount(db, makeInput());

    expect(result.uuids).toEqual(['b', 'a', 'c', 'e', 'd']);
    expect(result.hasMore).toBe(false);
    expect(result.readers).toEqual({ walk: 1, full: 1 });
  });

  it('leaves an angle nobody has climbed at to the full query', async () => {
    const climbs = mixedBoard();
    await seed(db, climbs);

    const result = await searchAndCount(db, makeInput({ angle: 70, boulders: true, routes: true }));

    // No stats at 70 degrees: every climb is unsent there, so the order is uuid alone.
    expect(result.uuids).toEqual(
      expectedOrder(climbs.map((climb) => ({ ...climb, ascents: undefined }))).slice(0, PAGE_SIZE),
    );
    expect(result.readers).toEqual({ walk: 1, full: 1 });
  });
});

describe('searchClimbsLocal: which searches take the ranked walk', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await stampLocalUserId(db, LOCAL_OWNER);
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
    const result = await searchAndCount(db, makeInput(overrides));

    expect(result.captured.filter((query) => query.sql.includes('idx_stats_ascents'))).toEqual([]);
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
    const result = await searchAndCount(db, makeInput({ boulders: true, routes: true, ...overrides }));

    expect(result.uuids).toHaveLength(PAGE_SIZE);
    expect(result.hasMore).toBe(true);
    expect(result.readers).toEqual({ walk: 1, full: 0 });
  });
});

describe('searchClimbsLocal: the ranked walk is bounded and index-served', () => {
  let db: TestSqliteDb;

  const RANKED = 12_100;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await stampLocalUserId(db, LOCAL_OWNER);
    // 12,100 climbs, each with its own ascent count: rank r (0 = most climbed)
    // is uuid `r-<r>` with count 20,000 - r. The 60 at ranks 12,030..12,089 are
    // the only hard ones (grade 30); 40 more at ranks 100..139 are grade 25.
    await db.execAsync(`
      WITH RECURSIVE ranks(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM ranks WHERE r < ${RANKED - 1})
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden, frames_count, frames,
         compatible_size_ids, required_set_ids, setter_username, created_at, updated_at)
      SELECT printf('r-%05d', r), 'kilter', 1, printf('Rank %d', r), 1, 0, 0, 1, '',
         '[5]', '[1,20]', 'setter', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      FROM ranks;
    `);
    await db.execAsync(`
      WITH RECURSIVE ranks(r) AS (SELECT 0 UNION ALL SELECT r + 1 FROM ranks WHERE r < ${RANKED - 1})
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, updated_at)
      SELECT 'kilter', printf('r-%05d', r), 40,
         CASE WHEN r BETWEEN 12030 AND 12089 THEN 30 WHEN r BETWEEN 100 AND 139 THEN 25 ELSE 16 END,
         20000 - r, '2026-01-01T00:00:00Z'
      FROM ranks;
    `);
  });

  const rankUuid = (rank: number) => `r-${String(rank).padStart(5, '0')}`;

  it('stops at its budget and lets the full query answer when the matches lie beyond it', async () => {
    const result = await searchAndCount(db, makeInput({ minGrade: 30, maxGrade: 30 }));

    // The walk read ranks 0..11,999, found nothing, and gave up; it did not go
    // on to rank 12,030. The rows are right because the full query supplied them.
    expect(result.readers).toEqual({ walk: 1, full: 1 });
    expect(result.uuids).toEqual(Array.from({ length: PAGE_SIZE }, (_unused, index) => rankUuid(12_030 + index)));
    expect(result.hasMore).toBe(true);

    const edgeProbe = result.captured.find(isEdgeProbe);
    expect(edgeProbe?.binds).toEqual(['kilter', 40, 12_000]);
    const walk = result.captured.find(isWalkRead);
    expect(walk?.sql).toContain('(s.ascensionist_count, s.climb_uuid) > (?, ?)');
    // The row at rank 12,000 is the first one the walk does not read.
    expect(walk?.binds).toEqual(expect.arrayContaining([20_000 - 12_000, rankUuid(12_000)]));
  });

  it('answers from the walk when the page fills inside the budget', async () => {
    const first = await searchAndCount(db, makeInput({ minGrade: 25, maxGrade: 25 }));
    expect(first.readers).toEqual({ walk: 1, full: 0 });
    expect(first.uuids).toEqual(Array.from({ length: PAGE_SIZE }, (_unused, index) => rankUuid(100 + index)));
    expect(first.hasMore).toBe(true);

    // The second page needs 41 matches and only 40 exist: the full query's.
    const second = await searchAndCount(db, makeInput({ minGrade: 25, maxGrade: 25, page: 1 }));
    expect(second.readers).toEqual({ walk: 1, full: 1 });
    expect(second.uuids).toEqual(Array.from({ length: PAGE_SIZE }, (_unused, index) => rankUuid(120 + index)));
    expect(second.hasMore).toBe(false);
  });

  it('widens the budget with the depth of the page, and drops the bound once it covers the angle', async () => {
    // Page 24 wants rows 480..500: 501 rows, 25 stats rows each.
    const deep = await searchAndCount(db, makeInput({ page: 24 }));
    expect(deep.captured.find(isEdgeProbe)?.binds).toEqual(['kilter', 40, 12_525]);
    expect(deep.readers).toEqual({ walk: 1, full: 0 });
    expect(deep.uuids[0]).toBe(rankUuid(480));
    // 12,525 is past the angle's 12,100 rows, so there is no edge to stop at.
    expect(deep.captured.find(isWalkRead)?.sql).not.toContain('(s.ascensionist_count, s.climb_uuid) > (?, ?)');

    const shallow = await searchAndCount(db, makeInput({ page: 3 }));
    expect(shallow.captured.find(isEdgeProbe)?.binds).toEqual(['kilter', 40, 12_000]);
    expect(shallow.uuids[0]).toBe(rankUuid(60));
  });

  it('is served by the index: no sort, climbs by primary key, the probe from the index alone', async () => {
    const result = await searchAndCount(db, makeInput({ page: 2, hideCompleted: true }));
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
  });
});
