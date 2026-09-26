import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { rowsFromResult } from '@boardsesh/db/client';
import { syncSharedData, upsertClimbStats } from '@boardsesh/aurora-sync/sync';
import type { BetaLink, Climb, ClimbStats, SyncData } from '@boardsesh/aurora-sync/api';
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
// write path (every upsert, the history snapshot) is real.
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

describe('syncSharedData: per-pass climb_stats write counts (real DB)', () => {
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

  it('logs offered vs written, and leaves an unchanged row and its stamp alone', async () => {
    const tag = uniqueTag();
    const stats = [auroraStat(`${tag}-a`), auroraStat(`${tag}-b`)];
    const logLines: string[] = [];
    mockSharedSync.mockResolvedValue(complete({ climb_stats: stats }));

    const firstRun = await syncSharedData(client, BOARD, 'token', (line) => logLines.push(line));
    expect(firstRun.climbStatsWrites).toEqual({ received: 2, offered: 2, written: 2 });
    expect(logLines).toContain(`[SharedSync] ${BOARD} climb_stats writes: received=2 offered=2 written=2 unchanged=0`);
    const rowBefore = await statsRow(stats[0].climb_uuid);
    expect(rowBefore.upstream_synced_at).not.toBeNull();

    // Aurora re-sends the same rows: nothing is written.
    logLines.length = 0;
    const secondRun = await syncSharedData(client, BOARD, 'token', (line) => logLines.push(line));
    expect(secondRun.climbStatsWrites).toEqual({ received: 2, offered: 2, written: 0 });
    expect(logLines).toContain(`[SharedSync] ${BOARD} climb_stats writes: received=2 offered=2 written=0 unchanged=2`);
    // The row was not rewritten, so its xmin and stamp stay where they were.
    expect(await statsRow(stats[0].climb_uuid)).toEqual(rowBefore);
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

describe('Aurora climbs upsert skips unchanged rows (real DB)', () => {
  it('rewrites a re-sent climb only when one of its five written columns changed', async () => {
    const tag = uniqueTag();
    const client = postgres(getWorkerDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
    const auroraClimb = (uuid: string, overrides: Partial<Climb> = {}): Climb => ({
      uuid,
      name: 'Crimp city',
      description: 'Beta: trust the heel',
      hsm: 1,
      edge_left: 0,
      edge_right: 100,
      edge_bottom: 0,
      edge_top: 100,
      frames_count: 1,
      frames_pace: 0,
      frames: 'p1r5',
      setter_id: 7,
      setter_username: 'setter',
      layout_id: 9,
      is_draft: false,
      is_listed: true,
      created_at: '2024-01-01 00:00:00',
      updated_at: '2024-01-01 00:00:00',
      angle: 40,
      ...overrides,
    });
    const climbUuids = [`${tag}-climb-a`, `${tag}-climb-b`];
    const climbRows = async () => {
      const rows = rowsFromResult<{ uuid: string; xmin: string; name: string | null }>(
        await db.execute(sql`
          SELECT uuid, xmin::text AS xmin, name FROM board_climbs
           WHERE uuid IN (${climbUuids[0]}, ${climbUuids[1]}) ORDER BY uuid`),
      );
      if (rows.length !== 2) throw new Error(`expected 2 climbs, found ${rows.length}`);
      return rows;
    };
    try {
      mockSharedSync.mockReset();
      mockSharedSync.mockResolvedValue({ _complete: true, climbs: climbUuids.map((uuid) => auroraClimb(uuid)) });
      await syncSharedData(client, BOARD, 'token', () => {});
      const inserted = await climbRows();

      // Identical re-send: neither row gets a new tuple.
      await syncSharedData(client, BOARD, 'token', () => {});
      expect(await climbRows()).toEqual(inserted);

      // A renamed b rewrites b and only b.
      mockSharedSync.mockResolvedValue({
        _complete: true,
        climbs: [auroraClimb(climbUuids[0]), auroraClimb(climbUuids[1], { name: 'Crimp city (renamed)' })],
      });
      await syncSharedData(client, BOARD, 'token', () => {});
      const [rowA, rowB] = await climbRows();
      expect(rowA).toEqual(inserted[0]);
      expect(rowB.name).toBe('Crimp city (renamed)');
      expect(rowB.xmin).not.toBe(inserted[1].xmin);
    } finally {
      await client.end();
    }
  });
});
