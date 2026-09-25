import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestSqliteDb } from '../../testing/sqlite-test-db';
import { markScopeDownloadComplete } from '../../sync/checkpoints';
import { offlineBoardKey, type OfflineBoardScope } from '../../offline-board-key';
import { ensureHoldIndex, holdIndexKey, isHoldIndexBehind, removeClimbFromHoldIndex } from '../hold-index';
import { HOLD_ROLE, HOLD_ROLE_OTHER } from '../query';
import {
  expectPostingsMatchHoldSets,
  holdSetOf,
  insertClimb as insertClimbInto,
  openTestDatabase,
  parseHoldRows,
  postingsOf,
  type ClimbSeed,
} from './hold-index-fixtures';

const KILTER_12: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 12 };
const KILTER_8: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 8 };

let db: TestSqliteDb;
let close: () => void;

const insertClimb = (seed: ClimbSeed) => insertClimbInto(db, seed);

async function watermarkOf(scope: OfflineBoardScope): Promise<Record<string, unknown> | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    holdIndexKey(offlineBoardKey(scope)),
  ]);
  return row ? JSON.parse(row.value) : null;
}

async function holdSetCount(): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM board_climb_hold_sets'))?.n ?? 0;
}

/** A shouldContinue that says yes `allowed` times, then no forever. */
function stopAfter(allowed: number): () => boolean {
  let checks = 0;
  return () => {
    checks += 1;
    return checks <= allowed;
  };
}

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  await markScopeDownloadComplete(db, offlineBoardKey(KILTER_12));
});

afterEach(() => close());

describe('ensureHoldIndex — first build', () => {
  it('indexes listed, published, visible climbs, with roles, and stamps the watermark at MAX(sync_seq)', async () => {
    await insertClimb({ uuid: 'listed', seq: 1, frames: 'p3r15p1r12p2r13p9r99' });
    await insertClimb({ uuid: 'draft', seq: 2, draft: 1 });
    await insertClimb({ uuid: 'unlisted', seq: 3, listed: 0 });
    await insertClimb({ uuid: 'hidden', seq: 4, hidden: 1 });
    await insertClimb({ uuid: 'legacy-null-hidden', seq: 5, hidden: null, frames: 'p1r14' });

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result).toMatchObject({ status: 'complete', climbsProcessed: 5, holdSetsWritten: 2 });
    // Sorted by hold id; 5 bytes each; an unknown role is kept as "other".
    expect(await holdSetOf(db, 'listed')).toEqual([
      [1, HOLD_ROLE.STARTING],
      [2, HOLD_ROLE.HAND],
      [3, HOLD_ROLE.FOOT],
      [9, HOLD_ROLE_OTHER],
    ]);
    expect(await holdSetOf(db, 'legacy-null-hidden')).toEqual([[1, HOLD_ROLE.FINISH]]);
    for (const uuid of ['draft', 'unlisted', 'hidden']) expect(await holdSetOf(db, uuid)).toBeNull();
    expect(await postingsOf(db, 'kilter', 1)).toEqual(
      new Map([
        [1, ['legacy-null-hidden', 'listed']],
        [2, ['listed']],
        [3, ['listed']],
        [9, ['listed']],
      ]),
    );
    expect(await watermarkOf(KILTER_12)).toEqual({ syncSeq: 5, updatedAt: null });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(false);
  });

  it('builds nothing for a scope that has not finished downloading', async () => {
    await insertClimb({ uuid: 'a', seq: 1, sizes: [8] });

    const result = await ensureHoldIndex(db, KILTER_8, { parseHoldRows });

    expect(result.status).toBe('not-downloaded');
    expect(await holdSetCount()).toBe(0);
    expect(await watermarkOf(KILTER_8)).toBeNull();
  });

  it('only reads the scope: other sizes, layouts and boards are skipped', async () => {
    await insertClimb({ uuid: 'in-scope', seq: 1 });
    await insertClimb({ uuid: 'other-size', seq: 2, sizes: [8] });
    await insertClimb({ uuid: 'other-layout', seq: 3, layoutId: 2 });
    await insertClimb({ uuid: 'other-board', seq: 4, boardType: 'tension' });

    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(await holdSetOf(db, 'in-scope')).not.toBeNull();
    for (const uuid of ['other-size', 'other-layout', 'other-board']) expect(await holdSetOf(db, uuid)).toBeNull();
  });

  it('ignores climbs with no holds or a NULL sync_seq', async () => {
    await insertClimb({ uuid: 'empty', seq: 1, frames: '' });
    await insertClimb({ uuid: 'missing', seq: 2, frames: null });
    await db.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, frames, is_listed, is_draft, sync_seq)
       VALUES ('no-seq', 'kilter', 1, '[12]', 'p1r12', 1, 0, NULL)`,
    );

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result).toMatchObject({ status: 'complete', climbsProcessed: 2, holdSetsWritten: 0 });
    expect(await holdSetCount()).toBe(0);
    expect(await watermarkOf(KILTER_12)).toMatchObject({ syncSeq: 2 });
  });

  it('restarts an interrupted first build from the top and loses nothing', async () => {
    for (let index = 1; index <= 7; index += 1) {
      await insertClimb({ uuid: `climb-${index}`, seq: 20 - index, frames: `p${index}r12p${index + 1}r13` });
    }

    // Stop partway through the hold-set chunks: some hold sets are written, no
    // posting and no watermark are.
    const first = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      initialChunkClimbs: 2,
      shouldContinue: stopAfter(7),
    });
    expect(first.status).toBe('aborted');
    expect(await holdSetCount()).toBeGreaterThan(0);
    expect(await holdSetCount()).toBeLessThan(7);
    expect(await watermarkOf(KILTER_12)).toBeNull();
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(true);

    const second = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, initialChunkClimbs: 2 });

    expect(second.status).toBe('complete');
    expect(await holdSetCount()).toBe(7);
    await expectPostingsMatchHoldSets(db, 'kilter', 1);
    expect(await watermarkOf(KILTER_12)).toEqual({ syncSeq: 19, updatedAt: null });
  });

  it('writes nothing when shouldContinue is false from the start', async () => {
    await insertClimb({ uuid: 'a', seq: 1 });

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, shouldContinue: () => false });

    expect(result).toMatchObject({ status: 'aborted', chunks: 0 });
    expect(await holdSetCount()).toBe(0);
    expect(await watermarkOf(KILTER_12)).toBeNull();
  });

  it('rolls a chunk back when shouldContinue flips under the write lock', async () => {
    await insertClimb({ uuid: 'a', seq: 1 });

    // Pre-target, pre-read and pre-write checks pass; the under-lock check fails.
    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, shouldContinue: stopAfter(3) });

    expect(result.status).toBe('aborted');
    expect(await holdSetCount()).toBe(0);
  });

  it('stops without writing once the scope is torn down mid-build', async () => {
    for (let seq = 1; seq <= 4; seq += 1) await insertClimb({ uuid: `climb-${seq}`, seq });
    let checks = 0;

    const result = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      initialChunkClimbs: 2,
      shouldContinue: () => {
        checks += 1;
        // Before chunk two's read: a teardown takes the completion marker.
        if (checks === 5) {
          void db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`scope-complete:${offlineBoardKey(KILTER_12)}`]);
        }
        return true;
      },
    });

    expect(result).toMatchObject({ status: 'aborted', chunks: 1 });
    expect(await holdSetCount()).toBe(2);
    expect(await watermarkOf(KILTER_12)).toBeNull();
  });

  it('hands over to the incremental phase, which picks up climbs that changed during the first build', async () => {
    for (let index = 1; index <= 4; index += 1) await insertClimb({ uuid: `m-${index}`, seq: index, frames: 'p1r12' });
    let checks = 0;

    const result = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      initialChunkClimbs: 2,
      shouldContinue: () => {
        checks += 1;
        // Before the second first-build chunk: a climb lands BEHIND the uuid walk
        // and an already-walked climb is edited. Both are above the recorded
        // MAX(sync_seq), so the incremental phase owns them.
        if (checks === 5) {
          void insertClimb({ uuid: 'a-new', seq: 20, frames: 'p7r14' });
          void insertClimb({ uuid: 'm-1', seq: 21, frames: 'p9r15' });
        }
        return true;
      },
    });

    expect(result.status).toBe('complete');
    expect(await holdSetOf(db, 'a-new')).toEqual([[7, HOLD_ROLE.FINISH]]);
    expect(await holdSetOf(db, 'm-1')).toEqual([[9, HOLD_ROLE.FOOT]]);
    await expectPostingsMatchHoldSets(db, 'kilter', 1);
    expect(await watermarkOf(KILTER_12)).toMatchObject({ syncSeq: 21 });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(false);
  });

  it('builds a second size of the same layout whose climbs are older, sharing the layout postings', async () => {
    await insertClimb({ uuid: 'size-12', seq: 50, sizes: [12], frames: 'p1r12' });
    await insertClimb({ uuid: 'shared', seq: 40, sizes: [8, 12], frames: 'p1r12p2r13' });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    await insertClimb({ uuid: 'size-8', seq: 3, sizes: [8], frames: 'p2r13' });
    await markScopeDownloadComplete(db, offlineBoardKey(KILTER_8));
    const result = await ensureHoldIndex(db, KILTER_8, { parseHoldRows });

    expect(result.status).toBe('complete');
    // The shared climb's hold set was already right, so it is not rewritten.
    expect(result.holdSetsWritten).toBe(1);
    expect(await postingsOf(db, 'kilter', 1)).toEqual(
      new Map([
        [1, ['shared', 'size-12']],
        [2, ['shared', 'size-8']],
      ]),
    );
    expect(await watermarkOf(KILTER_8)).toMatchObject({ syncSeq: 40 });
    expect(await watermarkOf(KILTER_12)).toMatchObject({ syncSeq: 50 });
  });

  it('indexes MoonBoard without a size filter', async () => {
    const moonboard: OfflineBoardScope = { boardType: 'moonboard', layoutId: 2, sizeId: 1 };
    await markScopeDownloadComplete(db, offlineBoardKey(moonboard));
    await insertClimb({ uuid: 'moon', seq: 1, boardType: 'moonboard', layoutId: 2, sizes: null, frames: 'p1r42' });

    await ensureHoldIndex(db, moonboard, { parseHoldRows });

    expect(await holdSetOf(db, 'moon')).toEqual([[1, HOLD_ROLE_OTHER]]);
  });
});

describe('ensureHoldIndex — incremental', () => {
  beforeEach(async () => {
    await insertClimb({ uuid: 'base', seq: 1, frames: 'p1r12p2r13' });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
  });

  it('re-derives an edited climb and moves it between postings', async () => {
    await insertClimb({ uuid: 'base', seq: 7, frames: 'p2r13p5r14' });

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result).toMatchObject({ climbsProcessed: 1, holdSetsWritten: 1 });
    expect(await postingsOf(db, 'kilter', 1)).toEqual(
      new Map([
        [2, ['base']],
        [5, ['base']],
      ]),
    );
    await expectPostingsMatchHoldSets(db, 'kilter', 1);
  });

  it('adds new climbs and removes one that is hidden later', async () => {
    await insertClimb({ uuid: 'new', seq: 2, frames: 'p1r12' });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    expect((await postingsOf(db, 'kilter', 1)).get(1)).toEqual(['base', 'new']);

    await insertClimb({ uuid: 'base', seq: 3, hidden: 1 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(await holdSetOf(db, 'base')).toBeNull();
    expect(await postingsOf(db, 'kilter', 1)).toEqual(new Map([[1, ['new']]]));
  });

  it('resumes an interrupted incremental phase from its sync_seq', async () => {
    for (let seq = 2; seq <= 5; seq += 1) await insertClimb({ uuid: `later-${seq}`, seq, frames: `p${seq}r13` });

    // Pre-read, pre-write, under-lock: chunk one commits, chunk two never reads.
    const stopped = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      chunkClimbs: 2,
      shouldContinue: stopAfter(3),
    });
    expect(stopped).toMatchObject({ status: 'aborted', chunks: 1 });
    expect(await watermarkOf(KILTER_12)).toMatchObject({ syncSeq: 3 });

    const resumed = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, chunkClimbs: 2 });

    expect(resumed).toMatchObject({ status: 'complete', climbsProcessed: 2 });
    expect(await holdSetCount()).toBe(5);
    await expectPostingsMatchHoldSets(db, 'kilter', 1);
  });

  it('writes nothing for a climb whose sync_seq moved but whose holds did not', async () => {
    await insertClimb({ uuid: 'base', seq: 9, frames: 'p1r12p2r13' });

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result).toMatchObject({ climbsProcessed: 1, holdSetsWritten: 0, postingsWritten: 0 });
    expect(await watermarkOf(KILTER_12)).toMatchObject({ syncSeq: 9 });
  });

  it('sweeps hold sets whose climb is gone only when asked', async () => {
    await insertClimb({ uuid: 'reconciled-away', seq: 2, frames: 'p1r12p8r13' });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    await db.runAsync("DELETE FROM board_climbs WHERE uuid = 'reconciled-away'");

    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    expect(await holdSetOf(db, 'reconciled-away')).not.toBeNull();

    const swept = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, sweepOrphans: true });

    expect(swept.holdSetsDeleted).toBe(1);
    expect(await holdSetOf(db, 'reconciled-away')).toBeNull();
    expect(await postingsOf(db, 'kilter', 1)).toEqual(
      new Map([
        [1, ['base']],
        [2, ['base']],
      ]),
    );
  });

  it('invalidates the holds query keys only when the index changed', async () => {
    const queryClient = { invalidateQueries: vi.fn() };
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows, queryClient });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    await insertClimb({ uuid: 'draft', seq: 2, draft: 1 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows, queryClient });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    await insertClimb({ uuid: 'new', seq: 3 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows, queryClient });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['similarClimbs'] });
  });
});

describe('removeClimbFromHoldIndex', () => {
  it('takes the climb out of every posting and drops its hold set', async () => {
    await insertClimb({ uuid: 'a', seq: 1, frames: 'p1r12p2r13' });
    await insertClimb({ uuid: 'b', seq: 2, frames: 'p2r13' });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    await db.withExclusiveTransactionAsync(async (txn) => {
      await removeClimbFromHoldIndex(txn, { uuid: 'a', boardType: 'kilter', layoutId: 1 });
    });

    expect(await holdSetOf(db, 'a')).toBeNull();
    expect(await postingsOf(db, 'kilter', 1)).toEqual(new Map([[2, ['b']]]));
  });
});

describe('single flight', () => {
  it('runs one build when two callers ask for the same scope at once', async () => {
    for (let seq = 1; seq <= 3; seq += 1) await insertClimb({ uuid: `climb-${seq}`, seq });
    const parser = vi.fn(parseHoldRows);

    const [first, second] = await Promise.all([
      ensureHoldIndex(db, KILTER_12, { parseHoldRows: parser }),
      ensureHoldIndex(db, KILTER_12, { parseHoldRows: parser }),
    ]);

    expect(parser).toHaveBeenCalledTimes(3);
    expect(second).toBe(first);
  });

  it('serialises two sizes of one layout, and both end consistent', async () => {
    await markScopeDownloadComplete(db, offlineBoardKey(KILTER_8));
    await insertClimb({ uuid: 'twelve', seq: 1, sizes: [12], frames: 'p1r12' });
    await insertClimb({ uuid: 'eight', seq: 2, sizes: [8], frames: 'p1r12' });

    const [twelve, eight] = await Promise.all([
      ensureHoldIndex(db, KILTER_12, { parseHoldRows }),
      ensureHoldIndex(db, KILTER_8, { parseHoldRows }),
    ]);

    expect(twelve.status).toBe('complete');
    expect(eight.status).toBe('complete');
    expect((await postingsOf(db, 'kilter', 1)).get(1)).toEqual(['eight', 'twelve']);
  });
});

describe('isHoldIndexBehind', () => {
  it('is true until the index has caught up, and again when a newer climb arrives', async () => {
    await insertClimb({ uuid: 'a', seq: 1 });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(true);

    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(false);

    await insertClimb({ uuid: 'b', seq: 2 });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(true);
  });

  it('uses the sync_seq index for the probe, and the uuid key for the first-build walk', async () => {
    const probe = await db.getAllAsync<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT 1 FROM board_climbs WHERE board_type = 'kilter' AND layout_id = 1 AND sync_seq > 0 ORDER BY sync_seq LIMIT 1",
    );
    expect(probe.map((row) => row.detail).join(' ')).toContain('idx_climbs_sync_seq');

    const walk = await db.getAllAsync<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT uuid FROM board_climbs WHERE uuid > '' AND +board_type = 'kilter' AND +layout_id = 1 AND +sync_seq IS NOT NULL ORDER BY uuid LIMIT 500",
    );
    const walkPlan = walk.map((row) => row.detail).join(' ');
    expect(walkPlan).not.toContain('TEMP B-TREE');
    expect(walkPlan).toMatch(/sqlite_autoindex_board_climbs_1/);
  });
});
