import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { markScopeDownloadComplete } from '../../sync/checkpoints';
import { offlineBoardKey, type OfflineBoardScope } from '../../offline-board-key';
import { ensureHoldIndex, holdIndexKey, isHoldIndexBehind, type HoldRowParser } from '../hold-index';

// A stand-in for board-constants' parser: `p<id>r<code>` → one row per hold,
// first occurrence wins. The engine only needs the contract, not the real table.
const parseHoldRows: HoldRowParser = (_boardType, frames) => {
  const rows: { holdId: number; holdState: string }[] = [];
  const seen = new Set<number>();
  for (const match of frames.matchAll(/p(\d+)r(\d+)/g)) {
    const holdId = Number(match[1]);
    if (seen.has(holdId)) continue;
    seen.add(holdId);
    rows.push({ holdId, holdState: `STATE_${match[2]}` });
  }
  return rows;
};

const KILTER_12: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 12 };
const KILTER_8: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 8 };

let directory: string;
let db: TestSqliteDb;

type ClimbSeed = {
  uuid: string;
  seq: number;
  frames?: string | null;
  sizes?: number[];
  boardType?: string;
  layoutId?: number;
  listed?: number;
  draft?: number;
  hidden?: number | null;
};

async function insertClimb(seed: ClimbSeed): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO board_climbs
       (uuid, board_type, layout_id, compatible_size_ids, frames, is_listed, is_draft, is_hidden, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      seed.uuid,
      seed.boardType ?? 'kilter',
      seed.layoutId ?? 1,
      JSON.stringify(seed.sizes ?? [12]),
      seed.frames === undefined ? 'p1r12p2r13' : seed.frames,
      seed.listed ?? 1,
      seed.draft ?? 0,
      seed.hidden === undefined ? 0 : seed.hidden,
      `2026-09-01T00:00:${String(seed.seq % 60).padStart(2, '0')}.000Z`,
      seed.seq,
    ],
  );
}

async function holdsOf(uuid: string): Promise<{ hold_id: number; hold_state: string }[]> {
  return db.getAllAsync('SELECT hold_id, hold_state FROM board_climb_holds WHERE climb_uuid = ? ORDER BY hold_id', [
    uuid,
  ]);
}

async function holdRowCount(): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM board_climb_holds'))?.n ?? 0;
}

async function watermarkOf(scope: OfflineBoardScope): Promise<Record<string, unknown> | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    holdIndexKey(offlineBoardKey(scope)),
  ]);
  return row ? JSON.parse(row.value) : null;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hold-index-'));
  db = createTestDatabase(join(directory, 'main.db'));
  await runMigrations(db);
  await markScopeDownloadComplete(db, offlineBoardKey(KILTER_12));
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('ensureHoldIndex', () => {
  it('builds rows for listed, published, visible climbs and advances the watermark past the rest', async () => {
    await insertClimb({ uuid: 'listed', seq: 1, frames: 'p1r12p2r13p3r15' });
    await insertClimb({ uuid: 'draft', seq: 2, draft: 1 });
    await insertClimb({ uuid: 'unlisted', seq: 3, listed: 0 });
    await insertClimb({ uuid: 'hidden', seq: 4, hidden: 1 });
    await insertClimb({ uuid: 'legacy-null-hidden', seq: 5, hidden: null, frames: 'p9r14' });

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result).toMatchObject({ status: 'complete', climbsProcessed: 5, rowsInserted: 4, chunks: 1 });
    expect(await holdsOf('listed')).toEqual([
      { hold_id: 1, hold_state: 'STATE_12' },
      { hold_id: 2, hold_state: 'STATE_13' },
      { hold_id: 3, hold_state: 'STATE_15' },
    ]);
    expect(await holdsOf('legacy-null-hidden')).toEqual([{ hold_id: 9, hold_state: 'STATE_14' }]);
    for (const uuid of ['draft', 'unlisted', 'hidden']) expect(await holdsOf(uuid)).toEqual([]);
    // The first build walks uuid order and hands over at the scope's MAX(sync_seq).
    expect(await watermarkOf(KILTER_12)).toEqual({ phase: 'incremental', syncSeq: 5, updatedAt: null });
  });

  it('creates the table WITHOUT ROWID', async () => {
    const row = await db.getFirstAsync<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'board_climb_holds'",
    );
    expect(row?.sql).toMatch(/WITHOUT ROWID/);
  });

  it('builds nothing for a scope that has not finished downloading', async () => {
    await insertClimb({ uuid: 'a', seq: 1, sizes: [8] });

    const result = await ensureHoldIndex(db, KILTER_8, { parseHoldRows });

    expect(result.status).toBe('not-downloaded');
    expect(await holdRowCount()).toBe(0);
    expect(await watermarkOf(KILTER_8)).toBeNull();
  });

  it('only reads climbs in the scope: other sizes, layouts and boards are skipped', async () => {
    await insertClimb({ uuid: 'in-scope', seq: 1 });
    await insertClimb({ uuid: 'other-size', seq: 2, sizes: [8] });
    await insertClimb({ uuid: 'other-layout', seq: 3, layoutId: 2 });
    await insertClimb({ uuid: 'other-board', seq: 4, boardType: 'tension' });

    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect((await holdsOf('in-scope')).length).toBe(2);
    for (const uuid of ['other-size', 'other-layout', 'other-board']) expect(await holdsOf(uuid)).toEqual([]);
  });

  it('re-derives a climb whose sync_seq moved, replacing its old rows', async () => {
    await insertClimb({ uuid: 'edited', seq: 1, frames: 'p1r12p2r13' });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    await insertClimb({ uuid: 'edited', seq: 7, frames: 'p5r14' });
    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result).toMatchObject({ climbsProcessed: 1, rowsInserted: 1, rowsDeleted: 2 });
    expect(await holdsOf('edited')).toEqual([{ hold_id: 5, hold_state: 'STATE_14' }]);
  });

  it('removes the rows of a climb that is hidden later', async () => {
    await insertClimb({ uuid: 'flip', seq: 1 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    expect((await holdsOf('flip')).length).toBe(2);

    await insertClimb({ uuid: 'flip', seq: 2, hidden: 1 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(await holdsOf('flip')).toEqual([]);
  });

  it('advances the watermark over climbs with empty or missing frames', async () => {
    await insertClimb({ uuid: 'empty', seq: 1, frames: '' });
    await insertClimb({ uuid: 'missing', seq: 2, frames: null });

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result).toMatchObject({ status: 'complete', climbsProcessed: 2, rowsInserted: 0 });
    expect(await watermarkOf(KILTER_12)).toMatchObject({ phase: 'incremental', syncSeq: 2 });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(false);
  });

  it('ignores rows with a NULL sync_seq', async () => {
    await insertClimb({ uuid: 'counted', seq: 1 });
    await db.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, frames, is_listed, is_draft, sync_seq)
       VALUES ('no-seq', 'kilter', 1, '[12]', 'p1r12', 1, 0, NULL)`,
    );

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    expect(result.climbsProcessed).toBe(1);
    expect(await holdsOf('no-seq')).toEqual([]);
  });

  // shouldContinue is consulted: once before the first build's phase stamp, then
  // twice for that stamp (before the write, under the lock), then three times per
  // chunk (before the read, before the write, under the lock).
  it('resumes the first build from the last committed uuid after being stopped mid-walk', async () => {
    // sync_seq order is the reverse of uuid order, so the walk order is visible.
    for (let index = 1; index <= 5; index += 1) {
      await insertClimb({ uuid: `climb-${index}`, seq: 10 - index, frames: `p${index}r12` });
    }

    let checks = 0;
    const first = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      shouldContinue: () => {
        checks += 1;
        return checks <= 6;
      },
      chunkClimbs: 2,
    });

    expect(first).toMatchObject({ status: 'aborted', chunks: 1, climbsProcessed: 2 });
    expect((await holdsOf('climb-1')).length).toBe(1);
    expect((await holdsOf('climb-2')).length).toBe(1);
    expect(await holdRowCount()).toBe(2);
    expect(await watermarkOf(KILTER_12)).toEqual({ phase: 'initial', lastUuid: 'climb-2', targetSyncSeq: 9 });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(true);

    const second = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, chunkClimbs: 2 });

    expect(second).toMatchObject({ status: 'complete', chunks: 2, climbsProcessed: 3 });
    expect(await holdRowCount()).toBe(5);
    expect(await watermarkOf(KILTER_12)).toEqual({ phase: 'incremental', syncSeq: 9, updatedAt: null });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(false);
  });

  it('hands the first build over to the incremental phase, which picks up climbs that changed mid-walk', async () => {
    for (let index = 1; index <= 4; index += 1) await insertClimb({ uuid: `m-${index}`, seq: index, frames: 'p1r12' });

    let checks = 0;
    const result = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      chunkClimbs: 2,
      shouldContinue: () => {
        checks += 1;
        // Before the second walk chunk's read: a new climb lands BEHIND the walk
        // (its uuid sorts first) and an already-walked climb is edited. Both carry
        // a sync_seq above the walk's target, so the incremental phase owns them.
        if (checks === 7) {
          void insertClimb({ uuid: 'a-new', seq: 20, frames: 'p7r14' });
          void insertClimb({ uuid: 'm-1', seq: 21, frames: 'p9r15' });
        }
        return true;
      },
    });

    expect(result.status).toBe('complete');
    expect(await holdsOf('a-new')).toEqual([{ hold_id: 7, hold_state: 'STATE_14' }]);
    expect(await holdsOf('m-1')).toEqual([{ hold_id: 9, hold_state: 'STATE_15' }]);
    expect(await watermarkOf(KILTER_12)).toMatchObject({ phase: 'incremental', syncSeq: 21 });
    expect(await isHoldIndexBehind(db, KILTER_12)).toBe(false);
  });

  it('continues an interrupted incremental phase from its sync_seq', async () => {
    await insertClimb({ uuid: 'first', seq: 1 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    for (let seq = 2; seq <= 5; seq += 1) await insertClimb({ uuid: `later-${seq}`, seq });

    let checks = 0;
    const stopped = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      chunkClimbs: 2,
      shouldContinue: () => {
        checks += 1;
        return checks <= 3;
      },
    });
    expect(stopped).toMatchObject({ status: 'aborted', chunks: 1 });
    expect(await watermarkOf(KILTER_12)).toMatchObject({ phase: 'incremental', syncSeq: 3 });

    const resumed = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, chunkClimbs: 2 });
    expect(resumed).toMatchObject({ status: 'complete', climbsProcessed: 2 });
    expect(await holdRowCount()).toBe(10);
  });

  it('writes nothing when shouldContinue is false from the start', async () => {
    await insertClimb({ uuid: 'a', seq: 1 });

    const result = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, shouldContinue: () => false });

    expect(result).toMatchObject({ status: 'aborted', chunks: 0 });
    expect(await holdRowCount()).toBe(0);
    expect(await watermarkOf(KILTER_12)).toBeNull();
  });

  it('rolls the chunk back when shouldContinue flips while the write lock is being taken', async () => {
    await insertClimb({ uuid: 'a', seq: 1 });
    let checks = 0;

    const result = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      // The phase stamp (checks 1-3) and the chunk's pre-read and pre-write
      // checks pass; the chunk's under-lock check fails.
      shouldContinue: () => {
        checks += 1;
        return checks <= 5;
      },
    });

    expect(result.status).toBe('aborted');
    expect(await holdRowCount()).toBe(0);
    expect(await watermarkOf(KILTER_12)).toEqual({ phase: 'initial', lastUuid: null, targetSyncSeq: 1 });
  });

  it('stops without writing when the scope was torn down between chunks', async () => {
    for (let seq = 1; seq <= 4; seq += 1) await insertClimb({ uuid: `climb-${seq}`, seq });
    let checks = 0;

    const result = await ensureHoldIndex(db, KILTER_12, {
      parseHoldRows,
      chunkClimbs: 2,
      shouldContinue: () => {
        checks += 1;
        // Before chunk two's read: a teardown takes the completion marker.
        if (checks === 7) {
          void db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`scope-complete:${offlineBoardKey(KILTER_12)}`]);
        }
        return true;
      },
    });

    expect(result).toMatchObject({ status: 'aborted', chunks: 1 });
    expect(await holdRowCount()).toBe(4);
  });

  it('indexes a second size of the same layout even when its climbs are older than the first scope', async () => {
    await insertClimb({ uuid: 'size-12', seq: 50, sizes: [12] });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });

    // Downloaded later, but its unique climb carries an older sync_seq.
    await insertClimb({ uuid: 'size-8', seq: 3, sizes: [8] });
    await markScopeDownloadComplete(db, offlineBoardKey(KILTER_8));
    const result = await ensureHoldIndex(db, KILTER_8, { parseHoldRows });

    expect(result.status).toBe('complete');
    expect((await holdsOf('size-8')).length).toBe(2);
    expect(await watermarkOf(KILTER_8)).toMatchObject({ phase: 'incremental', syncSeq: 3 });
    expect(await watermarkOf(KILTER_12)).toMatchObject({ phase: 'incremental', syncSeq: 50 });
  });

  it('indexes every MoonBoard climb without a size filter', async () => {
    const moonboard: OfflineBoardScope = { boardType: 'moonboard', layoutId: 2, sizeId: 1 };
    await markScopeDownloadComplete(db, offlineBoardKey(moonboard));
    await db.runAsync(
      `INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, frames, is_listed, is_draft, sync_seq)
       VALUES ('moon', 'moonboard', 2, NULL, 'p1r42', 1, 0, 1)`,
    );

    await ensureHoldIndex(db, moonboard, { parseHoldRows });

    expect(await holdsOf('moon')).toEqual([{ hold_id: 1, hold_state: 'STATE_42' }]);
  });

  it('sweeps rows whose climb is gone only when asked', async () => {
    await insertClimb({ uuid: 'kept', seq: 1 });
    await insertClimb({ uuid: 'reconciled-away', seq: 2 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    await db.runAsync("DELETE FROM board_climbs WHERE uuid = 'reconciled-away'");

    await ensureHoldIndex(db, KILTER_12, { parseHoldRows });
    expect((await holdsOf('reconciled-away')).length).toBe(2);

    const swept = await ensureHoldIndex(db, KILTER_12, { parseHoldRows, sweepOrphans: true });

    expect(swept.rowsDeleted).toBe(2);
    expect(await holdsOf('reconciled-away')).toEqual([]);
    expect((await holdsOf('kept')).length).toBe(2);
  });

  it('invalidates the holds query keys only when rows changed', async () => {
    const queryClient = { invalidateQueries: vi.fn() };
    await insertClimb({ uuid: 'a', seq: 1 });

    await ensureHoldIndex(db, KILTER_12, { parseHoldRows, queryClient });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['similarClimbs'] });

    queryClient.invalidateQueries.mockClear();
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows, queryClient });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();

    // A new climb with no indexable rows moves the watermark but changes no rows.
    await insertClimb({ uuid: 'draft', seq: 2, draft: 1 });
    await ensureHoldIndex(db, KILTER_12, { parseHoldRows, queryClient });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('runs one build per scope when two callers ask at once', async () => {
    for (let seq = 1; seq <= 3; seq += 1) await insertClimb({ uuid: `climb-${seq}`, seq });
    const parser = vi.fn(parseHoldRows);

    const [first, second] = await Promise.all([
      ensureHoldIndex(db, KILTER_12, { parseHoldRows: parser }),
      ensureHoldIndex(db, KILTER_12, { parseHoldRows: parser }),
    ]);

    expect(parser).toHaveBeenCalledTimes(3);
    expect(second).toBe(first);
    expect(await holdRowCount()).toBe(6);
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

  it('walks the uuid primary key for the first build instead of sorting the scope', async () => {
    const plan = await db.getAllAsync<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT uuid FROM board_climbs WHERE uuid > '' AND +board_type = 'kilter' AND +layout_id = 1 AND +sync_seq IS NOT NULL ORDER BY uuid LIMIT 500",
    );
    const details = plan.map((row) => row.detail).join(' ');
    expect(details).not.toContain('TEMP B-TREE');
    expect(details).toMatch(/sqlite_autoindex_board_climbs_1/);
  });

  it('uses the sync_seq index for the probe', async () => {
    const plan = await db.getAllAsync<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT 1 FROM board_climbs WHERE board_type = 'kilter' AND layout_id = 1 AND sync_seq > 0 ORDER BY sync_seq LIMIT 1",
    );
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_climbs_sync_seq');
  });
});
