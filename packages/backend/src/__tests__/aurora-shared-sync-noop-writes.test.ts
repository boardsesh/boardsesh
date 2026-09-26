import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { rowsFromResult } from '@boardsesh/db/client';
import {
  CLIMB_STATS_PASS_CURSOR,
  markClimbStatsPassCompleted,
  readClimbStatsPassStartedAt,
} from '@boardsesh/db/queries';
import { syncSharedData, upsertClimbStats } from '@boardsesh/aurora-sync/sync';
import type { BetaLink, ClimbStats, SyncData } from '@boardsesh/aurora-sync/api';
import { db } from '../db/client';
import { getWorkerDatabaseUrl } from './worker-db';

// ---------------------------------------------------------------------------
// Aurora shared sync: unchanged re-sends are not rewritten (real Postgres).
//
// Aurora's climb_stats cursor re-sends most of the table every pass. The
// upsert used to rewrite every re-sent row (new tuple, WAL, full-page images)
// because its SET always moved upstream_synced_at and tick_graded_at. The
// ON CONFLICT … WHERE guard now skips a row unless a SET value would change,
// the row was never stamped, or it carries a tick-derived grade marker (#4798).
//
// "Was this row rewritten" is read from xmin: any UPDATE, HOT or not, writes a
// new tuple with a new xmin; a skipped ON CONFLICT only locks the row.
// ---------------------------------------------------------------------------

const { mockSharedSync } = vi.hoisted(() => ({ mockSharedSync: vi.fn() }));

// The only network call in syncSharedData. Mocked by file so the rest of the
// write path (every upsert, the pass marker, the history snapshot) is real.
vi.mock('../../../aurora-sync/src/api/shared-sync-api', () => ({ sharedSync: mockSharedSync }));

const BOARD = 'tension';

function auroraStat(climbUuid: string, overrides: Partial<ClimbStats> = {}): ClimbStats {
  return {
    climb_uuid: climbUuid,
    angle: 40,
    display_difficulty: 20,
    benchmark_difficulty: null,
    ascensionist_count: 12,
    difficulty_average: 20.25,
    quality_average: 2.5,
    fa_username: 'setter',
    fa_at: '2024-01-02 03:04:05',
    ...overrides,
  };
}

type StatsRowState = {
  xmin: string;
  upstream_synced_at: string | null;
  upstream_ascensionist_count: string | null;
  display_difficulty: number | null;
  tick_graded_at: string | null;
};

async function statsRow(climbUuid: string): Promise<StatsRowState> {
  const [row] = rowsFromResult<StatsRowState>(
    await db.execute(sql`
      SELECT xmin::text AS xmin, upstream_synced_at::text AS upstream_synced_at,
             upstream_ascensionist_count::text AS upstream_ascensionist_count,
             display_difficulty, tick_graded_at::text AS tick_graded_at
        FROM board_climb_stats
       WHERE board_type = ${BOARD} AND climb_uuid = ${climbUuid} AND angle = 40`),
  );
  if (!row) throw new Error(`no stats row for ${climbUuid}`);
  return row;
}

let tagCounter = 0;
function uniqueTag(): string {
  tagCounter += 1;
  return `noop-${process.pid}-${tagCounter}`;
}

describe('Aurora climb_stats upsert skips unchanged rows (real DB)', () => {
  it('writes 0 rows for an identical batch, then exactly the changed rows', async () => {
    const tag = uniqueTag();
    const batch = [auroraStat(`${tag}-a`), auroraStat(`${tag}-b`), auroraStat(`${tag}-c`)];

    const firstPass = await upsertClimbStats(db, BOARD, batch);
    expect(firstPass).toEqual({ received: 3, offered: 3, written: 3 });
    const before = await Promise.all(batch.map((stat) => statsRow(stat.climb_uuid)));

    const identicalPass = await upsertClimbStats(db, BOARD, batch);
    expect(identicalPass).toEqual({ received: 3, offered: 3, written: 0 });
    const afterIdentical = await Promise.all(batch.map((stat) => statsRow(stat.climb_uuid)));
    expect(afterIdentical).toEqual(before);

    // One real change (a new ascent on b) writes b and only b.
    const changedBatch = [batch[0], { ...batch[1], ascensionist_count: 13 }, batch[2]];
    const changedPass = await upsertClimbStats(db, BOARD, changedBatch);
    expect(changedPass).toEqual({ received: 3, offered: 3, written: 1 });
    const [rowA, rowB, rowC] = await Promise.all(batch.map((stat) => statsRow(stat.climb_uuid)));
    expect(rowA).toEqual(before[0]);
    expect(rowC).toEqual(before[2]);
    expect(rowB.xmin).not.toBe(before[1].xmin);
    expect(rowB.upstream_ascensionist_count).toBe('13');
    // The row stamp moves with the write.
    expect(rowB.upstream_synced_at).not.toBe(before[1].upstream_synced_at);
  });

  it('still writes a row carrying a tick-derived grade marker, clearing it (#4798)', async () => {
    const tag = uniqueTag();
    const stat = auroraStat(`${tag}-graded`);
    await upsertClimbStats(db, BOARD, [stat]);
    // The recompute graded this row from ticks; its grade happens to equal
    // Aurora's. The marker still says "ours", so Aurora must take it back.
    await db.execute(sql`
      UPDATE board_climb_stats SET tick_graded_at = '2026-09-01 00:00:00'
       WHERE board_type = ${BOARD} AND climb_uuid = ${stat.climb_uuid} AND angle = 40`);
    const marked = await statsRow(stat.climb_uuid);
    expect(marked.tick_graded_at).not.toBeNull();

    const pass = await upsertClimbStats(db, BOARD, [stat]);
    expect(pass.written).toBe(1);
    const after = await statsRow(stat.climb_uuid);
    expect(after.tick_graded_at).toBeNull();
    expect(after.display_difficulty).toBe(20);
    expect(after.xmin).not.toBe(marked.xmin);
  });

  it('stamps a never-stamped row once, even when its values already match', async () => {
    const tag = uniqueTag();
    const stat = auroraStat(`${tag}-unstamped`);
    await upsertClimbStats(db, BOARD, [stat]);
    await db.execute(sql`
      UPDATE board_climb_stats SET upstream_synced_at = NULL
       WHERE board_type = ${BOARD} AND climb_uuid = ${stat.climb_uuid} AND angle = 40`);

    expect((await upsertClimbStats(db, BOARD, [stat])).written).toBe(1);
    expect((await statsRow(stat.climb_uuid)).upstream_synced_at).not.toBeNull();
    // …and never again while nothing changes.
    expect((await upsertClimbStats(db, BOARD, [stat])).written).toBe(0);
  });
});

describe('syncSharedData: per-pass counts and the board pass marker (real DB)', () => {
  const client = postgres(getWorkerDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });

  beforeEach(async () => {
    mockSharedSync.mockReset();
    await db.execute(sql`DELETE FROM board_shared_syncs WHERE board_type = ${BOARD}`);
  });

  afterAll(async () => {
    await client.end();
  });

  function complete(payload: Partial<SyncData>): SyncData {
    return { _complete: true, ...payload };
  }

  it('logs offered vs written, and marks the pass start at or before every row stamp', async () => {
    const tag = uniqueTag();
    const stats = [auroraStat(`${tag}-a`), auroraStat(`${tag}-b`)];
    const logLines: string[] = [];
    mockSharedSync.mockResolvedValue(complete({ climb_stats: stats }));

    const firstRun = await syncSharedData(client, BOARD, 'token', (line) => logLines.push(line));
    expect(firstRun.climbStatsWrites).toEqual({ received: 2, offered: 2, written: 2 });
    expect(logLines).toContain(`[SharedSync] ${BOARD} climb_stats writes: received=2 offered=2 written=2 unchanged=0`);

    const passStartedAtMs = (await readClimbStatsPassStartedAt(db, BOARD))?.getTime() ?? Number.NaN;
    const rowStamp = (await statsRow(stats[0].climb_uuid)).upstream_synced_at ?? '';
    // upstream_synced_at holds the ISO string's UTC wall time, zoneless.
    const rowStampMs = Date.parse(`${rowStamp.replace(' ', 'T')}Z`);
    expect(Number.isFinite(passStartedAtMs)).toBe(true);
    expect(Number.isFinite(rowStampMs)).toBe(true);
    expect(passStartedAtMs).toBeLessThanOrEqual(rowStampMs);

    // Aurora re-sends the same rows: nothing is written, the pass still counts.
    logLines.length = 0;
    const secondRun = await syncSharedData(client, BOARD, 'token', (line) => logLines.push(line));
    expect(secondRun.climbStatsWrites).toEqual({ received: 2, offered: 2, written: 0 });
    expect(logLines).toContain(`[SharedSync] ${BOARD} climb_stats writes: received=2 offered=2 written=0 unchanged=2`);
    const secondPassStartedAtMs = (await readClimbStatsPassStartedAt(db, BOARD))?.getTime() ?? Number.NaN;
    expect(secondPassStartedAtMs).toBeGreaterThan(passStartedAtMs);
    // The row itself was not rewritten, so its stamp stays where it was.
    expect((await statsRow(stats[0].climb_uuid)).upstream_synced_at).toBe(rowStamp);
  });

  it('does not mark a pass that never reached _complete', async () => {
    mockSharedSync.mockResolvedValue({ _complete: false, climb_stats: [] });

    const run = await syncSharedData(client, BOARD, 'token', () => {});
    expect(run.complete).toBe(false);
    const markers = rowsFromResult<{ table_name: string }>(
      await db.execute(sql`
        SELECT table_name FROM board_shared_syncs
         WHERE board_type = ${BOARD} AND table_name = ${CLIMB_STATS_PASS_CURSOR}`),
    );
    expect(markers).toEqual([]);
  });

  it('never moves the marker backward', async () => {
    await markClimbStatsPassCompleted(db, BOARD, '2026-09-26T10:00:00.000Z');
    await markClimbStatsPassCompleted(db, BOARD, '2026-09-26T09:00:00.000Z');
    expect((await readClimbStatsPassStartedAt(db, BOARD))?.toISOString()).toBe('2026-09-26T10:00:00.000Z');
  });
});

describe('Aurora beta_links upsert skips unchanged rows (real DB)', () => {
  it('rewrites a re-sent link only when a column changed', async () => {
    const tag = uniqueTag();
    const client = postgres(getWorkerDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
    try {
      const link: BetaLink = {
        climb_uuid: `${tag}-beta`,
        link: `https://instagram.com/p/${tag}`,
        foreign_username: 'climber',
        angle: 40,
        thumbnail: 'thumb.jpg',
        is_listed: true,
        created_at: '2024-01-01 00:00:00',
      };
      const betaLinkRow = async () => {
        const [row] = rowsFromResult<{ xmin: string; thumbnail: string | null }>(
          await db.execute(sql`
            SELECT xmin::text AS xmin, thumbnail FROM board_beta_links
             WHERE board_type = ${BOARD} AND climb_uuid = ${link.climb_uuid}`),
        );
        if (!row) throw new Error(`no beta link for ${link.climb_uuid}`);
        return row;
      };
      mockSharedSync.mockReset();
      mockSharedSync.mockResolvedValue({ _complete: true, beta_links: [link] });
      await syncSharedData(client, BOARD, 'token', () => {});
      const inserted = await betaLinkRow();

      await syncSharedData(client, BOARD, 'token', () => {});
      expect(await betaLinkRow()).toEqual(inserted);

      mockSharedSync.mockResolvedValue({ _complete: true, beta_links: [{ ...link, thumbnail: 'thumb2.jpg' }] });
      await syncSharedData(client, BOARD, 'token', () => {});
      const changed = await betaLinkRow();
      expect(changed.thumbnail).toBe('thumb2.jpg');
      expect(changed.xmin).not.toBe(inserted.xmin);
    } finally {
      await client.end();
    }
  });
});
