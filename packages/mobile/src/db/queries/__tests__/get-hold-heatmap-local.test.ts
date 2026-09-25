import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import {
  ensureMutationQueueTable,
  markScopeDownloadComplete,
  offlineBoardKey,
  runMigrations,
  stampLocalUserId,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

// The parser module reports build failures as breadcrumbs; keep Sentry out of it.
vi.mock('../../../lib/error-reporting', () => ({ addErrorBreadcrumb: vi.fn() }));

import { getHoldHeatmapLocal } from '../get-hold-heatmap-local';

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
    await markScopeDownloadComplete(db, offlineBoardKey(SCOPE));

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

  it('builds the index on first read and sums uses, roles, ascents and average difficulty', async () => {
    const stats = await getHoldHeatmapLocal(db, makeInput());

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

  it('follows the list filters: a grade range keeps only the climbs in it', async () => {
    const stats = await getHoldHeatmapLocal(db, makeInput({ minGrade: 18, maxGrade: 22 }));

    expect(stats.map((stat) => [stat.holdId, stat.totalUses, stat.totalAscents])).toEqual([
      [1, 1, 4],
      [2, 1, 4],
    ]);
  });

  it('reads a null average for holds whose climbs have no grade at the angle', async () => {
    await insertClimb(db, { uuid: 'ungraded', seq: 6, frames: 'p7r13' });

    const stats = await getHoldHeatmapLocal(db, makeInput());

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

    const stats = await getHoldHeatmapLocal(db, makeInput({ showOnlyCompleted: true }));

    expect(stats.map((stat) => stat.holdId)).toEqual([1, 2, 3]);
    expect(stats.every((stat) => stat.totalUses === 1)).toBe(true);
  });

  it('declines a hold-state filter the device cannot express, without building the index', async () => {
    const stats = await getHoldHeatmapLocal(db, makeInput({ holdsFilter: { hold_1: { STARTING: 'include' } } }));

    expect(stats).toEqual([]);
    const indexed = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM board_climb_hold_sets');
    expect(indexed?.count).toBe(0);
  });
});
