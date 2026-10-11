import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import {
  clearBoardTypeHoldIndex,
  ensureHoldIndex,
  ensureMutationQueueTable,
  offlineBoardKey,
  runMigrations,
  stampLocalUserId,
} from '@boardsesh/offline-sync';
import {
  createTestDatabase,
  markScopeDownloaded,
  rejectBinaryDatabaseResults,
  type TestSqliteDb,
} from '@boardsesh/offline-sync/testing';

// The parser module reports build failures as breadcrumbs; keep Sentry out of it.
vi.mock('../../../lib/error-reporting', () => ({ addErrorBreadcrumb: vi.fn() }));

import { parseHoldRows } from '../../../offline/hold-index-parser';
import { getHoldHeatmapLocal, getHoldHeatmapLocalWithCount } from '../get-hold-heatmap-local';

const OWNER = 'me';
const SCOPE = { boardType: 'kilter', layoutId: 1, sizeId: 10 };

function makeInput(overrides: Partial<ClimbSearchInput> = {}): ClimbSearchInput {
  return { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '', angle: 40, ...overrides };
}

type ClimbFixture = {
  uuid: string;
  seq: number;
  /** Kilter role codes: 12 start, 13 hand, 14 finish, 15 foot. */
  frames: string;
  hidden?: number;
  draft?: number;
  sizes?: number[];
};

async function insertClimb(db: TestSqliteDb, fixture: ClimbFixture): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs
       (uuid, board_type, layout_id, name, frames, frames_count, is_listed, is_draft, is_hidden,
        compatible_size_ids, created_at, updated_at, sync_seq)
     VALUES (?, 'kilter', 1, ?, ?, 1, 1, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
    [
      fixture.uuid,
      `Climb ${fixture.uuid}`,
      fixture.frames,
      fixture.draft ?? 0,
      fixture.hidden ?? 0,
      JSON.stringify(fixture.sizes ?? [10]),
      fixture.seq,
    ],
  );
}

async function insertStats(db: TestSqliteDb, climbUuid: string, ascents: number, difficulty: number): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_stats
       (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average,
        benchmark_difficulty, ascensionist_count, updated_at)
     VALUES ('kilter', ?, 40, ?, ?, 3, 0, ?, '2026-01-01T00:00:00Z')`,
    [climbUuid, difficulty, difficulty, ascents],
  );
}

async function insertSend(db: TestSqliteDb, uuid: string, climbUuid: string, userId: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count,
       quality, is_benchmark, climbed_at, created_at, updated_at)
     VALUES (?, ?, 'kilter', ?, 40, 0, 'send', 1, 3, 0, ?, ?, ?)`,
    [uuid, userId, climbUuid, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'],
  );
}

describe('getHoldHeatmapLocal', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await stampLocalUserId(db, OWNER);
    await markScopeDownloaded(db, offlineBoardKey(SCOPE));

    // alpha: start 1, hand 2, foot 3. bravo: start 1, finish 2.
    await insertClimb(db, { uuid: 'alpha', seq: 1, frames: 'p1r12p2r13p3r15' });
    await insertClimb(db, { uuid: 'bravo', seq: 2, frames: 'p1r12p2r14' });
    // Neither is on the list, so neither may reach the heatmap.
    await insertClimb(db, { uuid: 'hidden', seq: 3, frames: 'p9r13', hidden: 1 });
    await insertClimb(db, { uuid: 'draft', seq: 4, frames: 'p9r13', draft: 1 });
    // Another size of the layout: indexed with it, but outside this size's list.
    await insertClimb(db, { uuid: 'other-size', seq: 5, frames: 'p8r13', sizes: [99] });
    await insertStats(db, 'alpha', 10, 16);
    await insertStats(db, 'bravo', 4, 20);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('builds the index on first read and sums uses, roles, ascents and average difficulty', async () => {
    const stats = await getHoldHeatmapLocal(rejectBinaryDatabaseResults(db), makeInput());

    expect(stats).toEqual([
      {
        holdId: 1,
        totalUses: 2,
        startingUses: 2,
        handUses: 0,
        footUses: 0,
        finishUses: 0,
        totalAscents: 14,
        averageDifficulty: 18,
      },
      {
        holdId: 2,
        totalUses: 2,
        startingUses: 0,
        handUses: 1,
        footUses: 0,
        finishUses: 1,
        totalAscents: 14,
        averageDifficulty: 18,
      },
      {
        holdId: 3,
        totalUses: 1,
        startingUses: 0,
        handUses: 0,
        footUses: 1,
        finishUses: 0,
        totalAscents: 10,
        averageDifficulty: 16,
      },
    ]);
  });

  it('counts the climbs it folded, and skips the grade and ascent columns when asked', async () => {
    const { holdStats, climbCount } = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput(), {
      withStats: false,
    });
    // alpha and bravo: the hidden, draft and other-size climbs are outside the list.
    expect(climbCount).toBe(2);
    expect(holdStats.map((stat) => [stat.holdId, stat.totalUses])).toEqual([
      [1, 2],
      [2, 2],
      [3, 1],
    ]);
    expect(holdStats.every((stat) => stat.averageDifficulty === null && stat.totalAscents === 0)).toBe(true);
  });

  it('follows the list filters: a grade range keeps only the climbs in it', async () => {
    const stats = await getHoldHeatmapLocal(rejectBinaryDatabaseResults(db), makeInput({ minGrade: 18, maxGrade: 22 }));

    expect(stats.map((stat) => [stat.holdId, stat.totalUses, stat.totalAscents])).toEqual([
      [1, 1, 4],
      [2, 1, 4],
    ]);
  });

  it('reads a null average for holds whose climbs have no grade at the angle', async () => {
    await insertClimb(db, { uuid: 'ungraded', seq: 6, frames: 'p7r13' });

    const stats = await getHoldHeatmapLocal(rejectBinaryDatabaseResults(db), makeInput());

    expect(stats.find((stat) => stat.holdId === 7)).toMatchObject({
      totalUses: 1,
      totalAscents: 0,
      averageDifficulty: null,
    });
  });

  it("scopes personal-progress filters to the device owner's ticks", async () => {
    await insertSend(db, 't1', 'alpha', OWNER);
    // Another account's leftover row (a failed sign-out wipe) must not count.
    await insertSend(db, 't2', 'bravo', 'someone-else');

    const stats = await getHoldHeatmapLocal(rejectBinaryDatabaseResults(db), makeInput({ showOnlyCompleted: true }));

    expect(stats.map((stat) => stat.holdId)).toEqual([1, 2, 3]);
    expect(stats.every((stat) => stat.totalUses === 1)).toBe(true);
  });

  it('declines a hold-state filter the device cannot express, without building the index', async () => {
    const stats = await getHoldHeatmapLocal(
      rejectBinaryDatabaseResults(db),
      makeInput({ holdsFilter: { hold_1: { STARTING: 'include' } } }),
    );

    expect(stats).toEqual([]);
    const indexed = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM board_climb_hold_sets');
    expect(indexed?.count).toBe(0);
  });

  async function insertManyClimbs(count: number): Promise<void> {
    await db.runAsync(
      `WITH RECURSIVE climb_numbers(number) AS (
         SELECT 1 UNION ALL SELECT number + 1 FROM climb_numbers WHERE number < ?
       )
       INSERT INTO board_climbs
         (uuid, board_type, layout_id, name, frames, frames_count, is_listed, is_draft, is_hidden,
          compatible_size_ids, created_at, updated_at, sync_seq)
       SELECT printf('bulk-%06d', number), 'kilter', 1, 'Bulk climb', 'p1r12', 1, 1, 0, 0,
              '[10]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', number + 10
       FROM climb_numbers`,
      [count],
    );
    await db.runAsync(
      `INSERT INTO board_climb_stats
         (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average,
          benchmark_difficulty, ascensionist_count, updated_at)
       SELECT 'kilter', uuid, 40, 20, 20, 3, 0, 2, '2026-01-01T00:00:00Z'
       FROM board_climbs WHERE uuid LIKE 'bulk-%'`,
    );
  }

  function observePages(afterPage?: () => Promise<void>) {
    const getAllAsync = db.getAllAsync.bind(db);
    const pages: number[] = [];
    const plans: string[] = [];
    const candidatePlans: string[] = [];
    vi.spyOn(db, 'getAllAsync').mockImplementation(async (sql, ...params) => {
      const rows = await getAllAsync(sql, ...params);
      if (sql.includes('SELECT hs.climb_id') && sql.includes('FROM board_climbs c')) {
        const plan = await getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
        candidatePlans.push(...plan.map((step) => step.detail));
      }
      if (sql.includes('AS holds_hex') && sql.includes('CROSS JOIN')) {
        pages.push(rows.length);
        const plan = await getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
        plans.push(...plan.map((step) => step.detail));
        await afterPage?.();
      }
      return rows;
    });
    return { pages, plans, candidatePlans };
  }

  it.each([998, 1001])('folds %i additional climbs across page boundaries without truncation', async (count) => {
    await insertManyClimbs(count);
    const { pages, plans } = observePages();
    const result = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput());
    expect(result.climbCount).toBe(count + 2);
    expect(result.holdStats.find((stat) => stat.holdId === 1)).toMatchObject({
      totalUses: count + 2,
      startingUses: count + 2,
      totalAscents: count * 2 + 14,
      averageDifficulty: (count * 20 + 36) / (count + 2),
    });
    expect(pages[0]).toBe(1000);
    expect(pages.every((size) => size <= 1000)).toBe(true);
    expect(pages.reduce((total, size) => total + size, 0)).toBe(count + 2);
    expect(plans.some((detail) => /SEARCH hs USING INTEGER PRIMARY KEY/.test(detail))).toBe(true);
    expect(plans.some((detail) => detail.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false);
  });

  it('returns an empty aggregate without reading pages when the index has no hold sets', async () => {
    await db.runAsync('UPDATE board_climbs SET is_draft = 1, sync_seq = sync_seq + 100');
    const { pages } = observePages();
    const result = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput());
    expect(result).toEqual({ holdStats: [], climbCount: 0 });
    expect(pages).toEqual([]);
    expect(await db.getFirstAsync('SELECT MAX(climb_id) AS max_id FROM board_climb_hold_sets')).toEqual({
      max_id: null,
    });
  });

  it('reads only the captured candidates when another climb arrives between pages', async () => {
    await insertManyClimbs(1001);
    let inserted = false;
    observePages(async () => {
      if (inserted) return;
      inserted = true;
      await insertClimb(db, { uuid: 'later', seq: 9999, frames: 'p99r13' });
      await ensureHoldIndex(db, SCOPE, { parseHoldRows });
    });
    const result = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput(), {
      withStats: false,
    });
    expect(result.climbCount).toBe(1003);
    expect(result.holdStats.some((stat) => stat.holdId === 99)).toBe(false);
    expect(result.holdStats.every((stat) => stat.averageDifficulty === null && stat.totalAscents === 0)).toBe(true);
  });

  it('finds a small board through its scope index without scanning another downloaded layout', async () => {
    await insertManyClimbs(3000);
    await db.runAsync("UPDATE board_climbs SET layout_id = 2 WHERE uuid LIKE 'bulk-%'");
    const otherScope = { ...SCOPE, layoutId: 2 };
    await markScopeDownloaded(db, offlineBoardKey(otherScope));
    await ensureHoldIndex(db, otherScope, { parseHoldRows });

    const { pages, plans, candidatePlans } = observePages();
    const result = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput());
    expect(result.climbCount).toBe(2);
    expect(pages).toEqual([2]);
    expect(candidatePlans.some((detail) => /SEARCH c USING INDEX idx_climbs_search/.test(detail))).toBe(true);
    expect(candidatePlans.some((detail) => /SCAN hs/.test(detail))).toBe(false);
    expect(plans.some((detail) => /SEARCH hs USING INTEGER PRIMARY KEY/.test(detail))).toBe(true);
  });

  it.each([
    { minGrade: 16, maxGrade: 16, expectedCount: 1 },
    { minGrade: 1, maxGrade: 15, expectedCount: 0 },
  ])('bounds hold reads to sparse filter matches: $expectedCount', async ({ expectedCount, ...filter }) => {
    await insertManyClimbs(2000);
    const { pages, plans } = observePages();
    const result = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput(filter));
    expect(result.climbCount).toBe(expectedCount);
    expect(pages).toEqual(expectedCount ? [expectedCount] : []);
    expect(plans.every((detail) => !/SCAN hs/.test(detail))).toBe(true);
  });

  it('continues after an empty candidate page when sync changes matches', async () => {
    await insertManyClimbs(2001);
    const getAllAsync = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementation(async (sql, ...params) => {
      const rows = await getAllAsync(sql, ...params);
      if (sql.includes('SELECT hs.climb_id') && sql.includes('FROM board_climbs c')) {
        const candidates = rows as { climb_id: number }[];
        const firstPageIds = candidates.slice(0, 1000).map((candidate) => candidate.climb_id);
        await db.runAsync(
          `UPDATE board_climbs SET is_draft = 1
           WHERE uuid IN (SELECT uuid FROM holds_index_climbs WHERE id IN (${firstPageIds.map(() => '?').join(',')}))`,
          firstPageIds,
        );
      }
      return rows;
    });
    const result = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput());
    expect(result.climbCount).toBe(1003);
  });

  it('rejects a result if the account changes after a page', async () => {
    observePages(() => stampLocalUserId(db, 'new-owner'));
    await expect(getHoldHeatmapLocal(rejectBinaryDatabaseResults(db), makeInput())).rejects.toThrow(
      'account or downloaded scope changed',
    );
  });

  it('rejects a result if the index is torn down after a page', async () => {
    observePages(() => db.withExclusiveTransactionAsync((txn) => clearBoardTypeHoldIndex(txn, 'kilter')));
    await expect(getHoldHeatmapLocal(rejectBinaryDatabaseResults(db), makeInput())).rejects.toThrow(
      'account or downloaded scope changed',
    );
  });

  it('aggregates more climbs than the Android JNI reference ceiling without binary results', async () => {
    await insertManyClimbs(60_000);
    const { pages } = observePages();
    const result = await getHoldHeatmapLocalWithCount(rejectBinaryDatabaseResults(db), makeInput(), {
      withStats: false,
    });
    expect(result.climbCount).toBe(60_002);
    expect(result.holdStats.find((stat) => stat.holdId === 1)?.totalUses).toBe(60_002);
    expect(pages).toHaveLength(61);
    expect(Math.max(...pages)).toBe(1000);
  }, 30_000);
});
