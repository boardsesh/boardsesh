// Scope-teardown coverage against the REAL client DDL (node:sqlite — the same
// engine expo-sqlite uses), so the json_each size filtering, the semi-join deletes,
// and the marker cleanup all run for real with no mocking of the SQLite layer.
//
// Migrations are run rather than exec'ing SCHEMA_STATEMENTS: board_climb_grades only
// exists from migration 4, so a schema-only fixture wouldn't have the table this
// module deletes from.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { removeBoardScopeData, scopeSyncMetaKeys, getScopeUsage } from '../scope-teardown';
import { getCheckpoint, setCheckpoint, DELETIONS_CHECKPOINT_KEY, isScopeDownloadComplete } from '../checkpoints';
import { BOARD_DATA_TABLES } from '../table-config';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import type { OfflineBoardScope } from '../../offline-board-key';

const KILTER_12X12: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 5 };
const KILTER_8X12: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 7 };
const MOONBOARD_A: OfflineBoardScope = { boardType: 'moonboard', layoutId: 1, sizeId: 1 };
const MOONBOARD_B: OfflineBoardScope = { boardType: 'moonboard', layoutId: 1, sizeId: 2 };

let db: TestSqliteDb;

async function insertClimb(params: {
  uuid: string;
  boardType?: string;
  layoutId?: number;
  /** null models the bundled seed's unfiltered rows, which belong to no scope. */
  compatibleSizeIds: number[] | null;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, 0, 1, ?, '2026-06-01T00:00:00Z', 1)`,
    [
      params.uuid,
      params.boardType ?? 'kilter',
      params.layoutId ?? 1,
      params.uuid,
      params.compatibleSizeIds === null ? null : JSON.stringify(params.compatibleSizeIds),
    ],
  );
}

async function insertStats(climbUuid: string, boardType = 'kilter', angle = 40): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, updated_at, sync_seq)
     VALUES (?, ?, ?, 15, '2026-06-01T00:00:00Z', 1)`,
    [boardType, climbUuid, angle],
  );
}

async function insertGrade(climbUuid: string, boardType = 'kilter', angle = 40): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, computed_at, sync_seq)
     VALUES (?, ?, ?, '7A', '2026-06-01T00:00:00Z', 1)`,
    [boardType, climbUuid, angle],
  );
}

async function climbUuids(): Promise<string[]> {
  const rows = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
  return rows.map((row) => row.uuid);
}

async function countOf(table: string): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

beforeEach(async () => {
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
  await runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('removeBoardScopeData — which rows go', () => {
  // The most important case in this file. board_climbs rows are shared across sizes
  // of a layout, so removing one size must not gut the other.
  it('keeps rows a retained sibling size still needs', async () => {
    await insertClimb({ uuid: 'shared-5-and-7', compatibleSizeIds: [5, 7] });
    await insertClimb({ uuid: 'only-5', compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'only-7', compatibleSizeIds: [7] });

    await removeBoardScopeData({
      db,
      scope: KILTER_12X12,
      scopeKey: 'kilter:1:5',
      retainedScopes: [KILTER_8X12],
    });

    expect(await climbUuids()).toEqual(['only-7', 'shared-5-and-7']);
  });

  it('takes the whole layout when nothing is retained', async () => {
    await insertClimb({ uuid: 'shared-5-and-7', compatibleSizeIds: [5, 7] });
    await insertClimb({ uuid: 'only-5', compatibleSizeIds: [5] });

    const result = await removeBoardScopeData({
      db,
      scope: KILTER_12X12,
      scopeKey: 'kilter:1:5',
      retainedScopes: [],
    });

    expect(await climbUuids()).toEqual([]);
    expect(result.removedAnyRows).toBe(true);
  });

  it('leaves other layouts and other board types alone', async () => {
    await insertClimb({ uuid: 'target', compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'other-layout', layoutId: 2, compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'other-board', boardType: 'tension', compatibleSizeIds: [5] });

    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [] });

    expect(await climbUuids()).toEqual(['other-board', 'other-layout']);
  });

  // The bundled seed (connection.ts's loadOptionalSeed) copies board rows with no
  // scope predicate, so NULL-size rows exist. They belong to no scope and no read
  // path reaches them, so reclaiming them is the point.
  it('removes NULL compatible_size_ids rows, which belong to no scope', async () => {
    await insertClimb({ uuid: 'seeded-null-size', compatibleSizeIds: null });

    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [] });

    expect(await climbUuids()).toEqual([]);
  });

  // MoonBoard isn't size-scoped, so its scopes of one layout cover an identical row
  // set. Without the guard, the predicate would drop the size clause and delete the
  // whole layout out from under the retained board.
  it('deletes nothing for MoonBoard when a sibling scope is retained', async () => {
    await insertClimb({ uuid: 'moon-climb', boardType: 'moonboard', compatibleSizeIds: null });

    const result = await removeBoardScopeData({
      db,
      scope: MOONBOARD_A,
      scopeKey: 'moonboard:1:1',
      retainedScopes: [MOONBOARD_B],
    });

    expect(result.removedAnyRows).toBe(false);
    expect(await climbUuids()).toEqual(['moon-climb']);
  });

  it('deletes MoonBoard rows when nothing is retained', async () => {
    await insertClimb({ uuid: 'moon-climb', boardType: 'moonboard', compatibleSizeIds: null });

    await removeBoardScopeData({ db, scope: MOONBOARD_A, scopeKey: 'moonboard:1:1', retainedScopes: [] });

    expect(await climbUuids()).toEqual([]);
  });
});

describe('removeBoardScopeData — child tables', () => {
  // Regression guard for the delete ORDER. The stats/grades deletes resolve a
  // subquery against board_climbs, so deleting climbs first would silently delete
  // nothing from them. Flip the three statements and this must go red.
  it('deletes stats and grades of the removed climbs', async () => {
    await insertClimb({ uuid: 'going', compatibleSizeIds: [5] });
    await insertStats('going');
    await insertGrade('going');

    const result = await removeBoardScopeData({
      db,
      scope: KILTER_12X12,
      scopeKey: 'kilter:1:5',
      retainedScopes: [],
    });

    expect(await countOf('board_climb_stats')).toBe(0);
    expect(await countOf('board_climb_grades')).toBe(0);
    expect(result.statsDeleted).toBe(1);
    expect(result.gradesDeleted).toBe(1);
  });

  it('keeps stats and grades belonging to a retained size', async () => {
    await insertClimb({ uuid: 'only-5', compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'only-7', compatibleSizeIds: [7] });
    await insertStats('only-5');
    await insertStats('only-7');
    await insertGrade('only-5');
    // Same board_type and angle as the removed climb's grade — only the removed
    // climb's row may go, since grades carry no layout/size column of their own.
    await insertGrade('only-7');

    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [KILTER_8X12] });

    const stats = await db.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM board_climb_stats');
    const grades = await db.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM board_climb_grades');
    expect(stats.map((row) => row.climb_uuid)).toEqual(['only-7']);
    expect(grades.map((row) => row.climb_uuid)).toEqual(['only-7']);
  });

  // The targeted IN-subquery (rather than a board_type-wide orphan sweep) is what
  // makes this safe: a scope mid-crawl has stats whose climbs haven't landed yet, and
  // a sweep would delete them while their checkpoints stayed advanced — permanently
  // losing rows in a board the user never asked to remove.
  it('leaves a concurrently-downloading scope’s parentless stats untouched', async () => {
    await insertClimb({ uuid: 'going', compatibleSizeIds: [5] });
    await insertStats('going');
    // Scope kilter:1:7 is mid-download: stats landed, its climbs have not.
    await insertStats('climb-not-pulled-yet');

    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [KILTER_8X12] });

    const stats = await db.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM board_climb_stats');
    expect(stats.map((row) => row.climb_uuid)).toEqual(['climb-not-pulled-yet']);
  });
});

describe('removeBoardScopeData — markers', () => {
  async function seedMarkers(scopeKey: string): Promise<void> {
    for (const table of BOARD_DATA_TABLES) {
      await setCheckpoint(db, `checkpoint:${table}:${scopeKey}`, { updatedAt: '2026-06-01T00:00:00Z', syncSeq: '9' });
    }
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `scope-complete:${scopeKey}`,
      '1',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-attempts:${scopeKey}`,
      '2',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `bootstrap-done:${scopeKey}`,
      '1',
    ]);
  }

  // Rows and markers must die together. A surviving checkpoint means the strict `>`
  // delta pull resumes past the deleted rows and never revisits them, and a surviving
  // scope-complete marker makes local-first search serve the remnant as if it were the
  // whole catalog.
  it('clears every marker describing the scope', async () => {
    await insertClimb({ uuid: 'going', compatibleSizeIds: [5] });
    await seedMarkers('kilter:1:5');

    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [] });

    for (const key of scopeSyncMetaKeys('kilter:1:5')) {
      const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [key]);
      expect(row, `${key} should be gone`).toBeNull();
    }
    expect(await isScopeDownloadComplete(db, 'kilter:1:5')).toBe(false);
  });

  it('leaves a sibling scope’s markers intact', async () => {
    await insertClimb({ uuid: 'only-5', compatibleSizeIds: [5] });
    await seedMarkers('kilter:1:5');
    await seedMarkers('kilter:1:7');

    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [KILTER_8X12] });

    for (const key of scopeSyncMetaKeys('kilter:1:7')) {
      const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [key]);
      expect(row, `${key} should survive`).not.toBeNull();
    }
  });

  // Guards against anyone "tidying" the exact-key list into a LIKE 'checkpoint:%'
  // pattern, which would swallow the single global deletions cursor.
  it('never touches the global deletions checkpoint', async () => {
    const deletionsCursor = { updatedAt: '2026-06-05T00:00:00Z', syncSeq: '42' };
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, deletionsCursor);
    await insertClimb({ uuid: 'going', compatibleSizeIds: [5] });

    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [] });

    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual(deletionsCursor);
  });

  // Derived from BOARD_DATA_TABLES, so a future per-board table can't silently leave
  // its checkpoint behind — the gap board_climb_grades already fell through once.
  it('covers one checkpoint key per per-board table', async () => {
    const keys = scopeSyncMetaKeys('kilter:1:5');
    for (const table of BOARD_DATA_TABLES) {
      expect(keys).toContain(`checkpoint:${table}:kilter:1:5`);
    }
    expect(keys).toHaveLength(BOARD_DATA_TABLES.length + 3);
  });

  // The caller removes the MMKV setting before calling this, so a crash in between
  // leaves rows to re-reap on the next attempt.
  it('is idempotent', async () => {
    await insertClimb({ uuid: 'going', compatibleSizeIds: [5] });
    await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [] });

    const second = await removeBoardScopeData({ db, scope: KILTER_12X12, scopeKey: 'kilter:1:5', retainedScopes: [] });

    expect(second.removedAnyRows).toBe(false);
    expect(second.climbsDeleted).toBe(0);
  });
});

describe('getScopeUsage', () => {
  it('counts only the climbs in each scope', async () => {
    await insertClimb({ uuid: 'shared', compatibleSizeIds: [5, 7] });
    await insertClimb({ uuid: 'only-5', compatibleSizeIds: [5] });
    await insertClimb({ uuid: 'only-7', compatibleSizeIds: [7] });

    const usage = await getScopeUsage(db, [
      { scope: KILTER_12X12, scopeKey: 'kilter:1:5' },
      { scope: KILTER_8X12, scopeKey: 'kilter:1:7' },
    ]);

    expect(usage.map((entry) => entry.climbCount)).toEqual([2, 2]);
    // The shared row is counted by both scopes, so the parts sum to more than the
    // whole. The UI must never present these as adding up to the total.
    expect(usage[0].climbCount + usage[1].climbCount).toBeGreaterThan(await countOf('board_climbs'));
  });

  it('reports zero bytes rather than dividing by zero on an empty catalog', async () => {
    const usage = await getScopeUsage(db, [{ scope: KILTER_12X12, scopeKey: 'kilter:1:5' }]);

    expect(usage[0]).toMatchObject({ climbCount: 0, estimatedBytes: 0 });
  });
});
