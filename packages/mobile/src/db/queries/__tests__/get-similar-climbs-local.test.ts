// Similar climbs from the downloaded board: the same answers the server's
// `findSimilarClimbs` gives — threshold, self excluded, hidden / draft /
// unlisted / multi-frame / other-layout climbs dropped, Woods kept on one wall,
// and `jaccard DESC, ascents DESC, uuid` ordering — read through the real
// holds index built by the real frames parser.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHoldIndex, markScopeDownloadComplete, offlineBoardKey, runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { parseFramesToHoldRows } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldRowParser } from '@boardsesh/offline-sync';
import { getGradeLabel } from '../../../lib/grade-label';
import { getSimilarClimbsLocal } from '../get-similar-climbs-local';

const parseHoldRows: HoldRowParser = (boardType, frames) => parseFramesToHoldRows(boardType as BoardName, frames);

type Seed = {
  uuid: string;
  holds: number[];
  boardType?: string;
  layoutId?: number;
  sizes?: number[];
  listed?: number;
  draft?: number;
  hidden?: number | null;
  framesCount?: number;
  angle?: number | null;
};

let seq = 0;

/** Kilter frames: first hold STARTING (r12), the rest HAND (r13). Woods: r4 / r2. */
function framesFor(boardType: string, holds: number[]): string {
  const [start, hand] = boardType === 'woods' ? [4, 2] : [12, 13];
  return holds.map((holdId, index) => `p${holdId}r${index === 0 ? start : hand}`).join('');
}

async function insertClimb(db: TestSqliteDb, seed: Seed): Promise<void> {
  seq += 1;
  const boardType = seed.boardType ?? 'kilter';
  await db.runAsync(
    `INSERT INTO board_climbs
       (uuid, board_type, layout_id, name, setter_username, compatible_size_ids, characteristics, frames,
        frames_count, is_listed, is_draft, is_hidden, angle, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.uuid,
      boardType,
      seed.layoutId ?? 1,
      `Climb ${seed.uuid}`,
      'setter',
      JSON.stringify(seed.sizes ?? [5]),
      JSON.stringify(['no_match']),
      framesFor(boardType, seed.holds),
      seed.framesCount ?? 1,
      seed.listed ?? 1,
      seed.draft ?? 0,
      seed.hidden === undefined ? 0 : seed.hidden,
      seed.angle ?? null,
      '2026-09-01T00:00:00.000Z',
      seq,
    ],
  );
}

async function insertStat(
  db: TestSqliteDb,
  climbUuid: string,
  angle: number,
  stats: { ascents: number; difficulty?: number; quality?: number },
  boardType = 'kilter',
): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_stats
       (board_type, climb_uuid, angle, display_difficulty, quality_average, ascensionist_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      boardType,
      climbUuid,
      angle,
      stats.difficulty ?? null,
      stats.quality ?? null,
      stats.ascents,
      '2026-09-01T00:00:00.000Z',
    ],
  );
}

async function buildIndex(db: TestSqliteDb, scope: { boardType: string; layoutId: number; sizeId: number }) {
  await markScopeDownloadComplete(db, offlineBoardKey(scope));
  const result = await ensureHoldIndex(db, scope, { parseHoldRows });
  expect(result.status).toBe('complete');
}

let directory = '';
let db: TestSqliteDb;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'similar-local-'));
  db = createTestDatabase(join(directory, 'main.db'));
  await runMigrations(db);
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

const KILTER = { boardType: 'kilter', layoutId: 1, sizeId: 5 };

async function seedKilter(): Promise<void> {
  await insertClimb(db, { uuid: 'target', holds: [1, 2, 3, 4] });
  // 4 shared / 5 union = 0.8, two of them tied on jaccard: ascents break the tie.
  await insertClimb(db, { uuid: 'a-few-sends', holds: [1, 2, 3, 4, 5] });
  await insertClimb(db, { uuid: 'b-many-sends', holds: [1, 2, 3, 4, 6] });
  // Tied on jaccard AND ascents with a-few-sends: uuid breaks it.
  await insertClimb(db, { uuid: 'a-also-few', holds: [1, 2, 3, 4, 7] });
  // 4/6 = 0.667.
  await insertClimb(db, { uuid: 'wider', holds: [1, 2, 3, 4, 5, 6] });
  // 2/7 = 0.29: under the 0.5 default threshold.
  await insertClimb(db, { uuid: 'far', holds: [1, 2, 7, 8, 9] });
  // Identical holds, but every one of these is something the server drops.
  await insertClimb(db, { uuid: 'hidden', holds: [1, 2, 3, 4], hidden: 1 });
  await insertClimb(db, { uuid: 'draft', holds: [1, 2, 3, 4], draft: 1 });
  await insertClimb(db, { uuid: 'unlisted', holds: [1, 2, 3, 4], listed: 0 });
  await insertClimb(db, { uuid: 'multi-frame', holds: [1, 2, 3, 4], framesCount: 2 });
  await insertClimb(db, { uuid: 'other-layout', holds: [1, 2, 3, 4], layoutId: 2 });

  await insertStat(db, 'a-few-sends', 40, { ascents: 10, difficulty: 16, quality: 2.5 });
  await insertStat(db, 'a-also-few', 40, { ascents: 10 });
  await insertStat(db, 'b-many-sends', 40, { ascents: 50 });
  // At another angle the order flips — the join must use the requested angle.
  await insertStat(db, 'a-few-sends', 50, { ascents: 500 });
  await buildIndex(db, KILTER);
}

describe('getSimilarClimbsLocal', () => {
  it('matches the server: threshold, exclusions, and jaccard → ascents → uuid order', async () => {
    await seedKilter();
    const result = await getSimilarClimbsLocal(db, { ...KILTER, climbUuid: 'target', angle: 40 }, parseHoldRows);
    expect(result.map(({ uuid }) => uuid)).toEqual(['b-many-sends', 'a-also-few', 'a-few-sends', 'wider']);
    expect(result.map(({ similarity }) => similarity)).toEqual([0.8, 0.8, 0.8, 4 / 6]);
  });

  it('maps a row to the SimilarClimb shape the resolver returns', async () => {
    await seedKilter();
    const result = await getSimilarClimbsLocal(db, { ...KILTER, climbUuid: 'target', angle: 40 }, parseHoldRows);
    expect(result.find(({ uuid }) => uuid === 'a-few-sends')).toEqual({
      uuid: 'a-few-sends',
      name: 'Climb a-few-sends',
      setterUsername: 'setter',
      angle: null,
      layoutId: 1,
      frames: 'p1r12p2r13p3r13p4r13p5r13',
      difficultyName: getGradeLabel(16),
      qualityAverage: 2.5,
      ascensionistCount: 10,
      compatibleSizeIds: [5],
      characteristics: ['no_match'],
      similarity: 0.8,
      sharedHoldCount: 4,
      candidateHoldCount: 5,
      targetHoldCount: 4,
    });
    // No stats row at the angle: null numbers and no grade, never a fake 0.
    expect(result.find(({ uuid }) => uuid === 'wider')).toMatchObject({
      difficultyName: null,
      qualityAverage: null,
      ascensionistCount: null,
    });
  });

  it('reads stats at the requested angle', async () => {
    await seedKilter();
    const result = await getSimilarClimbsLocal(db, { ...KILTER, climbUuid: 'target', angle: 50 }, parseHoldRows);
    expect(result[0].uuid).toBe('a-few-sends');
    expect(result[0].ascensionistCount).toBe(500);
  });

  it('honours threshold and limit', async () => {
    await seedKilter();
    const strict = await getSimilarClimbsLocal(
      db,
      { ...KILTER, climbUuid: 'target', angle: 40, threshold: 0.7 },
      parseHoldRows,
    );
    expect(strict.map(({ uuid }) => uuid)).toEqual(['b-many-sends', 'a-also-few', 'a-few-sends']);
    const loose = await getSimilarClimbsLocal(
      db,
      { ...KILTER, climbUuid: 'target', angle: 40, threshold: 0.2, limit: 2 },
      parseHoldRows,
    );
    expect(loose.map(({ uuid }) => uuid)).toEqual(['b-many-sends', 'a-also-few']);
    const withFar = await getSimilarClimbsLocal(
      db,
      { ...KILTER, climbUuid: 'target', angle: 40, threshold: 0.2 },
      parseHoldRows,
    );
    expect(withFar.map(({ uuid }) => uuid)).toContain('far');
  });

  it("falls back to the target's frames when the index has no row for it", async () => {
    await seedKilter();
    // A hidden target is never indexed, but it still has holds to compare.
    await insertClimb(db, { uuid: 'hidden-target', holds: [1, 2, 3, 4], hidden: 1 });
    const result = await getSimilarClimbsLocal(db, { ...KILTER, climbUuid: 'hidden-target', angle: 40 }, parseHoldRows);
    expect(result.map(({ uuid }) => uuid)).toEqual(['target', 'b-many-sends', 'a-also-few', 'a-few-sends', 'wider']);
  });

  it('returns nothing for an unknown climb or an unbuilt index', async () => {
    await insertClimb(db, { uuid: 'target', holds: [1, 2, 3, 4] });
    await insertClimb(db, { uuid: 'twin', holds: [1, 2, 3, 4] });
    expect(await getSimilarClimbsLocal(db, { ...KILTER, climbUuid: 'target' }, parseHoldRows)).toEqual([]);
    await buildIndex(db, KILTER);
    expect(await getSimilarClimbsLocal(db, { ...KILTER, climbUuid: 'missing' }, parseHoldRows)).toEqual([]);
  });

  describe('Woods', () => {
    const WOODS_8 = { boardType: 'woods', layoutId: 1, sizeId: 1 };
    const WOODS_12 = { boardType: 'woods', layoutId: 1, sizeId: 2 };

    beforeEach(async () => {
      await insertClimb(db, { uuid: 'w-target', boardType: 'woods', holds: [1, 2, 3, 4], sizes: [1] });
      await insertClimb(db, { uuid: 'w-same-wall', boardType: 'woods', holds: [1, 2, 3, 4, 5], sizes: [1] });
      // Same hold ids on the other wall are different holds.
      await insertClimb(db, { uuid: 'w-other-wall', boardType: 'woods', holds: [1, 2, 3, 4], sizes: [2] });
      await buildIndex(db, WOODS_8);
      await buildIndex(db, WOODS_12);
    });

    it('keeps the comparison on the requested wall', async () => {
      const result = await getSimilarClimbsLocal(db, { ...WOODS_8, climbUuid: 'w-target' }, parseHoldRows);
      expect(result.map(({ uuid }) => uuid)).toEqual(['w-same-wall']);
    });

    it('fails closed without a size, like the server', async () => {
      const result = await getSimilarClimbsLocal(
        db,
        { boardType: 'woods', layoutId: 1, climbUuid: 'w-target' },
        parseHoldRows,
      );
      expect(result).toEqual([]);
    });
  });

  it('compares across sizes on every other board (bounding-box sizes)', async () => {
    await insertClimb(db, { uuid: 'target', holds: [1, 2, 3, 4], sizes: [5, 6] });
    await insertClimb(db, { uuid: 'bigger-wall-only', holds: [1, 2, 3, 4, 5], sizes: [5, 6] });
    await buildIndex(db, KILTER);
    const result = await getSimilarClimbsLocal(db, { ...KILTER, sizeId: 6, climbUuid: 'target' }, parseHoldRows);
    expect(result.map(({ uuid }) => uuid)).toEqual(['bigger-wall-only']);
  });
});
