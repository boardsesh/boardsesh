import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getClimbStatsHistoryLocal } from '../get-climb-stats-history-local';

async function insertStats(
  db: TestSqliteDb,
  opts: { climbUuid: string; angle: number; ascents: number; boardType?: string; updatedAt?: string | null },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, difficulty_average, quality_average, updated_at)
     VALUES (?, ?, ?, 20.4, ?, 20.1, 2.7, ?)`,
    [
      opts.boardType ?? 'kilter',
      opts.climbUuid,
      opts.angle,
      opts.ascents,
      opts.updatedAt === undefined ? '2026-09-25T10:00:00Z' : opts.updatedAt,
    ],
  );
}

describe('getClimbStatsHistoryLocal', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('returns one entry per angle with ascents, in the GraphQL shape, ascending by angle', async () => {
    await insertStats(db, { climbUuid: 'c1', angle: 45, ascents: 3 });
    await insertStats(db, { climbUuid: 'c1', angle: 40, ascents: 12 });
    await insertStats(db, { climbUuid: 'c1', angle: 20, ascents: 0 });
    await insertStats(db, { climbUuid: 'c2', angle: 40, ascents: 5 });
    await insertStats(db, { climbUuid: 'c1', angle: 40, ascents: 9, boardType: 'tension' });

    const entries = await getClimbStatsHistoryLocal(db, { boardName: 'kilter', climbUuid: 'c1' });
    expect(entries).toEqual([
      {
        angle: 40,
        ascensionistCount: 12,
        qualityAverage: 2.7,
        difficultyAverage: 20.1,
        displayDifficulty: 20.4,
        createdAt: '2026-09-25T10:00:00Z',
      },
      {
        angle: 45,
        ascensionistCount: 3,
        qualityAverage: 2.7,
        difficultyAverage: 20.1,
        displayDifficulty: 20.4,
        createdAt: '2026-09-25T10:00:00Z',
      },
    ]);
  });

  it('is empty for a climb nobody has sent', async () => {
    await insertStats(db, { climbUuid: 'c1', angle: 40, ascents: 0 });
    expect(await getClimbStatsHistoryLocal(db, { boardName: 'kilter', climbUuid: 'c1' })).toEqual([]);
  });

  it('keeps createdAt a string when a row has no updated_at', async () => {
    await insertStats(db, { climbUuid: 'c1', angle: 40, ascents: 1, updatedAt: null });
    const [entry] = await getClimbStatsHistoryLocal(db, { boardName: 'kilter', climbUuid: 'c1' });
    expect(typeof entry?.createdAt).toBe('string');
  });
});
