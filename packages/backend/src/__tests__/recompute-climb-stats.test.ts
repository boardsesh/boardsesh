import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { recomputeClimbStats as recomputeClimbStatsCore, recomputeClimbStatsBulk } from '@boardsesh/db/queries';
import { sqlText } from '@boardsesh/db/test-utils';
import { getWorkerDatabaseUrl, setupWorkerDatabase } from './worker-db';
import { logger } from '../utils/logger';

const { mockDb } = vi.hoisted(() => {
  // The `sql` template returns an object whose `.queryChunks` array holds the
  // alternating raw SQL strings and parameter sentinels. For assertion
  // purposes we just need the raw text — so we stitch the chunks back into a
  // single string, dropping placeholders.
  return {
    mockDb: {
      transaction: vi.fn(),
    },
  };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

import { recomputeClimbStats } from '../graphql/resolvers/ticks/recompute-climb-stats';

describe('recomputeClimbStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The seed's behaviour is asserted end to end against real Postgres in the
  // provenance-matrix block below (a phantom key seeds nothing; a real climb at
  // a new angle still does; quality_normalized). What this one pins is the
  // SHAPE: the seed must stay an INSERT ... SELECT FROM board_climbs so the
  // catalog lookup IS the guard (#3528). A regression to a plain VALUES insert
  // — which cannot carry a WHERE — silently un-guards it.
  it('seeds via INSERT ... SELECT FROM board_climbs so the catalog lookup guards it', async () => {
    const executed: unknown[] = [];
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        execute: vi.fn(async (query: unknown) => {
          executed.push(query);
          return [];
        }),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    const seedSql = sqlText(executed[0]);
    expect(seedSql).toContain('INSERT INTO board_climb_stats');
    expect(seedSql).toMatch(/SELECT[\s\S]*FROM board_climbs bc/);
    expect(seedSql).toMatch(/WHERE bc\.uuid =/);
    expect(seedSql).toMatch(/AND bc\.board_type =/);
    expect(seedSql).toContain('quality_normalized');
  });

  it('runs the seed + recompute SQL inside a single transaction', async () => {
    let executeCount = 0;
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        execute: vi.fn(async () => {
          executeCount += 1;
          return [];
        }),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // Seed + the aggregate recompute.
    expect(executeCount).toBe(2);
  });

  // FRAGILE TEST WARNING — read before changing:
  //
  // This test introspects drizzle's internal `queryChunks` representation of
  // the `sql\`...\`` template result, stitches the raw string fragments back
  // together, and greps for the SQL clauses the runtime depends on. It will
  // break if drizzle changes how `sql\`...\`` returns its AST (rename of
  // `queryChunks`, restructure of the chunk objects, etc.).
  //
  // We accept that fragility because the alternative — a real-DB integration
  // test that seeds a user + climb + ticks, calls recompute, asserts row
  // state, and cleans up — adds significant scaffolding that no other test
  // in this repo establishes. The end-to-end behavior IS covered: the
  // migration backfill in 0099_split_ascensionist_count.sql runs the same
  // logic against ~4,668 ticks-having climbs in the dev DB and the post-run
  // invariants are checked manually via the SQL spot-checks in the PR.
  //
  // If drizzle's internals shift and these assertions break, the right fix
  // is to add a real-DB integration test for recomputeClimbStats (using the
  // postgres test infra) rather than chase drizzle's AST shape.
  it('emits the SQL that COALESCEs distinct_senders to 0 (delete-last-tick path)', async () => {
    let capturedQuery: unknown = null;
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        execute: vi.fn(async (query: unknown) => {
          capturedQuery = query;
          return [];
        }),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    const sql = sqlText(capturedQuery);

    // Hard invariants the delete-last-tick path depends on:
    // 1. boardsesh_ascensionist_count defaults to 0 when no senders remain.
    expect(sql).toMatch(/boardsesh_ascensionist_count\s*=\s*COALESCE\(agg\.distinct_senders,\s*0\)/);
    // 2. ascensionist_count is the board's single upstream count plus Boardsesh's.
    //    Boardsesh ticks ADD to upstream; they never replace it.
    expect(sql).toContain('COALESCE(s.upstream_ascensionist_count, 0)');
    expect(sql).toContain('COALESCE(agg.distinct_senders, 0)');
    // The total ADDS Boardsesh senders to the upstream count — it never GREATESTs
    // or replaces it. This is the invariant that stops a Boardsesh tick from
    // wiping a MoonBoard climb's imported community repeats.
    expect(sql).toMatch(
      /ascensionist_count\s*=\s*COALESCE\(s\.upstream_ascensionist_count, 0\)\s*\+\s*COALESCE\(agg\.distinct_senders, 0\)/,
    );
    expect(sql).not.toContain('kilter_ascensionist_count');
    expect(sql).not.toContain('aurora_ascensionist_count');
    // 3. The ticks filter is sargable — predicate on WHERE, not FILTER.
    expect(sql).toMatch(/WHERE[\s\S]*bt\.status IN \('flash','send'\)/);
    // 4. Ownership-aware FA: Boardsesh climbs re-derive every pass.
    expect(sql).toContain('user_id IS NOT NULL');
    expect(sql).toContain('agg.first_user');
    expect(sql).toContain('agg.first_at');
  });

  // Same FRAGILE TEST WARNING as the case above — see the long comment for
  // why we live with the queryChunks introspection. If drizzle's AST shifts,
  // replace this case with a real-DB integration test instead of chasing it.
  it('emits ownership-aware writes for quality_average / difficulty_average / display_difficulty', async () => {
    let capturedQuery: unknown = null;
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        execute: vi.fn(async (query: unknown) => {
          capturedQuery = query;
          return [];
        }),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    const sql = sqlText(capturedQuery);

    // The agg CTE must compute the averages — Postgres AVG skips NULL inputs,
    // so a single rated tick is enough to populate the column. quality = 0 is a
    // legacy sentinel, excluded via NULLIF so it never drags the average down.
    expect(sql).toMatch(/AVG\(NULLIF\(bt\.quality, 0\)\)\s+AS avg_quality/);
    expect(sql).toMatch(/AVG\(bt\.difficulty\)\s+AS avg_difficulty/);

    // difficulty/display stay ownership-CASE-guarded so Aurora's averages
    // survive untouched on Aurora-synced climbs.
    expect(sql).toMatch(/difficulty_average\s*=\s*CASE[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.difficulty_average/);
    expect(sql).toMatch(/display_difficulty\s*=\s*CASE[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.display_difficulty/);

    // quality_average is ownership-branched too: OWNED climbs get the plain AVG,
    // NON-owned climbs get the blend (which weights upstream_quality_average by
    // the upstream ascent count) — NOT the bare stored quality_average.
    expect(sql).toMatch(/quality_average\s*=\s*CASE[\s\S]+?agg\.avg_quality[\s\S]+?upstream_quality_average/);
    // Boardsesh side of the blend: one vote per climber = LATEST rated native
    // flash/send tick, written to the sum/count columns for NON-owned climbs and
    // NULLed for owned (never blended).
    expect(sql).toMatch(/boardsesh_quality_sum\s*=\s*CASE[\s\S]+?bq\.bs_quality_sum/);
    expect(sql).toMatch(/boardsesh_quality_count\s*=\s*CASE[\s\S]+?NULLIF\(bq\.bs_quality_count, 0\)/);
    expect(sql).toMatch(/DISTINCT ON \(bt\.user_id\)/);
    expect(sql).toContain("bt.origin     = 'native'");
    expect(sql).toMatch(/ORDER BY bt\.user_id, bt\.climbed_at DESC, bt\.id DESC/);
  });

  it('emits a [recomputeClimbStats] info log line with prev/new diff when a row was updated', async () => {
    const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        // The combined WITH … RETURNING query returns one diff row.
        execute: vi.fn(async () => [
          {
            prev_bs: 0,
            prev_total: 3,
            prev_fa: null,
            new_bs: 1,
            new_total: 4,
            new_fa: 'Alice',
          },
        ]),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'D15DDE9F3F72410F', 40);

    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('[recomputeClimbStats]'));
    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('kilter/D15DDE9F/40'));
    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('boardsesh=1'));
    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('total=4'));
    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('delta=+1'));
    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('fa=set:Alice'));
    loggerSpy.mockRestore();
  });

  it('does not log when the UPDATE matched no row (defensive)', async () => {
    const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        execute: vi.fn(async () => []),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'D15DDE9F3F72410F', 40);

    const recomputeCalls = (loggerSpy.mock.calls as unknown as unknown[][]).filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[recomputeClimbStats]'),
    );
    expect(recomputeCalls).toHaveLength(0);
    loggerSpy.mockRestore();
  });

  it('classifies fa changes (unchanged, set, cleared, changed)', async () => {
    const cases: Array<{ prev: string | null; next: string | null; expected: string }> = [
      { prev: 'Alice', next: 'Alice', expected: 'fa=unchanged' },
      { prev: null, next: 'Alice', expected: 'fa=set:Alice' },
      { prev: 'Alice', next: null, expected: 'fa=cleared' },
      { prev: 'Alice', next: 'Bob', expected: 'fa=changed:Alice→Bob' },
    ];

    for (const { prev, next, expected } of cases) {
      const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
      mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
        const tx = {
          execute: vi.fn(async () => [
            { prev_bs: 0, prev_total: 0, prev_fa: prev, new_bs: 0, new_total: 0, new_fa: next },
          ]),
        };
        await callback(tx);
      });

      await recomputeClimbStats('kilter', 'CLIMB-1', 40);

      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining(expected));
      loggerSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Provenance matrix (real DB)
//
// The mocked SQL-introspection tests above assert we EMIT the right clauses;
// these exercise the actual counting behaviour against a real Postgres so the
// double-count fix is verified end to end. We pass our OWN drizzle handle to
// the shared @boardsesh/db/queries core, so the vi.mock('../db/client') above
// (which the wrapper uses) doesn't apply here.
// ---------------------------------------------------------------------------

describe('recomputeClimbStats — provenance matrix (real DB)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await setupWorkerDatabase();
    client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    db = drizzle(client);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE boardsesh_ticks, board_climb_stats, board_climbs, user_profiles, users RESTART IDENTITY CASCADE`,
    );
  });

  async function seedUser(id: string, name: string) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${id}, ${`${id}@test.com`}, ${name}, now(), now())
    `);
  }

  async function seedClimb(boardType: string, uuid: string, ownerUserId: string | null) {
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, user_id)
      VALUES (${uuid}, ${boardType}, 1, 'setter', 'Test Climb', '', 'p1r1', true, ${ownerUserId})
    `);
  }

  async function seedStats(
    boardType: string,
    uuid: string,
    angle: number,
    opts: {
      upstream?: number;
      faUsername?: string | null;
      faAt?: string | null;
      // Post-0168 shape: a non-owned synced climb carries its manufacturer
      // quality in both quality_average and upstream_quality_average.
      upstreamQuality?: number | null;
      upstreamSyncedAt?: string | null;
    } = {},
  ) {
    const upstreamQuality = opts.upstreamQuality ?? null;
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, upstream_ascensionist_count, ascensionist_count, boardsesh_ascensionist_count, fa_username, fa_at, quality_average, upstream_quality_average, quality_normalized, upstream_synced_at)
      VALUES (${boardType}, ${uuid}, ${angle}, ${opts.upstream ?? 0}, ${opts.upstream ?? 0}, 0, ${opts.faUsername ?? null}, ${opts.faAt ?? null}, ${upstreamQuality}, ${upstreamQuality}, true, ${opts.upstreamSyncedAt ?? null})
    `);
  }

  type SeedTick = {
    userId: string;
    boardType: string;
    climbUuid: string;
    angle: number;
    status: 'flash' | 'send' | 'attempt';
    origin: 'native' | 'aurora_pull' | 'kilter_pull' | 'json_import';
    quality?: number | null;
    difficulty?: number | null;
    climbedAt: string;
    kilterId?: string | null;
    kilterSyncedAt?: string | null;
  };

  async function seedTick(t: SeedTick) {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count, quality, difficulty, climbed_at, created_at, updated_at, kilter_id, kilter_synced_at)
      VALUES (gen_random_uuid()::text, ${t.userId}, ${t.boardType}, ${t.climbUuid}, ${t.angle}, ${t.status}::tick_status, ${t.origin}::tick_origin, 1, ${t.quality ?? null}, ${t.difficulty ?? null}, ${t.climbedAt}, now(), now(), ${t.kilterId ?? null}, ${t.kilterSyncedAt ?? null})
    `);
  }

  async function statsRow(boardType: string, uuid: string, angle: number) {
    const rows = (await db.execute(sql`
      SELECT boardsesh_ascensionist_count AS bs, ascensionist_count AS total, fa_username AS fa, fa_at AS fa_at,
             quality_average AS quality, upstream_quality_average AS upstream_quality,
             boardsesh_quality_sum AS bs_quality_sum, boardsesh_quality_count AS bs_quality_count
        FROM board_climb_stats
       WHERE board_type = ${boardType} AND climb_uuid = ${uuid} AND angle = ${angle}
    `)) as unknown as Array<{
      bs: number | string | null;
      total: number | string | null;
      fa: string | null;
      fa_at: string | null;
      quality: number | string | null;
      upstream_quality: number | string | null;
      bs_quality_sum: number | string | null;
      bs_quality_count: number | string | null;
    }>;
    const [row] = Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows;
    return row;
  }

  const KEY = { boardType: 'kilter', climbUuid: 'CLIMB-PROV', angle: 40 };

  it('native-only user counts toward boardsesh_ascensionist_count', async () => {
    await seedUser('u-native', 'Nadia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10 });
    await seedTick({ ...KEY, userId: 'u-native', status: 'send', origin: 'native', climbedAt: '2026-01-01 00:00:00' });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(1);
    expect(Number(row.total)).toBe(11); // upstream 10 + 1 native
  });

  it('pull-only user does NOT count (already inside upstream)', async () => {
    await seedUser('u-pull', 'Pedro');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10 });
    await seedTick({
      ...KEY,
      userId: 'u-pull',
      status: 'send',
      origin: 'aurora_pull',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(0);
    expect(Number(row.total)).toBe(10); // upstream only
  });

  it('imported ATTEMPT does not disqualify a native send (upstream counts have no bids)', async () => {
    await seedUser('u-attempt', 'Ana');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10 });
    await seedTick({
      ...KEY,
      userId: 'u-attempt',
      status: 'attempt',
      origin: 'kilter_pull',
      climbedAt: '2026-01-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-attempt',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-02-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(1); // the native send counts
    expect(Number(row.total)).toBe(11);
  });

  it('kilter_pull-only user does NOT count (already inside the Grips upstream count)', async () => {
    await seedUser('u-kpull', 'Kim');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 25 });
    await seedTick({
      ...KEY,
      userId: 'u-kpull',
      status: 'flash',
      origin: 'kilter_pull',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(0);
    expect(Number(row.total)).toBe(25); // upstream only
  });

  it('mixed user (native + imported tick at the same key) does NOT count', async () => {
    await seedUser('u-mixed', 'Mika');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10 });
    await seedTick({ ...KEY, userId: 'u-mixed', status: 'send', origin: 'native', climbedAt: '2026-02-01 00:00:00' });
    await seedTick({
      ...KEY,
      userId: 'u-mixed',
      status: 'send',
      origin: 'json_import',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(0); // upstream-represented → contributes 0
    expect(Number(row.total)).toBe(10);
  });

  it('freshly pushed-native tick (kilter_id set, not yet absorbed) KEEPS counting', async () => {
    await seedUser('u-push', 'Priya');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    // No upstream_synced_at + no kilter_synced_at → the absorption guard can't
    // fire, so a pushed-but-not-yet-absorbed native tick still counts.
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10 });
    await seedTick({
      ...KEY,
      userId: 'u-push',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
      kilterId: 'pushed-log-uuid',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(1); // origin still native, not absorbed → counts
    expect(Number(row.total)).toBe(11);
  });

  it('ABSORBED pushed-native tick (synced > 48h before upstream) STOPS counting', async () => {
    // Push landed in Kilter on Feb 1; the board's upstream count was last synced
    // Mar 1 — well past the 48h absorption horizon (Feb 27) — so Kilter's own
    // count already includes this ascent. Counting the native tick too would
    // double-count, so the user drops out of boardsesh_ascensionist_count.
    await seedUser('u-absorbed', 'Ada');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, {
      upstream: 10,
      upstreamSyncedAt: '2026-03-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-absorbed',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
      kilterId: 'pushed-log-uuid',
      kilterSyncedAt: '2026-02-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(0); // absorbed into upstream → contributes 0
    expect(Number(row.total)).toBe(10);
  });

  it('recently pushed-native tick (within 48h of upstream) STILL counts (fresh push)', async () => {
    // Pushed Feb 28 12:00, upstream synced Mar 1 00:00 → only ~36h apart, inside
    // the 48h horizon. The upstream snapshot may not have re-counted it yet, so
    // it keeps counting immediately (the locked product requirement).
    await seedUser('u-fresh', 'Fred');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, {
      upstream: 10,
      upstreamSyncedAt: '2026-03-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-fresh',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-02-28 00:00:00',
      kilterId: 'pushed-log-uuid',
      kilterSyncedAt: '2026-02-28 12:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(1); // within 48h → not yet absorbed → counts
    expect(Number(row.total)).toBe(11);
  });

  it('pushed-native tick with NULL upstream_synced_at is never absorbed (still counts)', async () => {
    // A board that never upstream-syncs (MoonBoard shape) can't have absorbed
    // anything, so the guard must not fire on a NULL watermark.
    await seedUser('u-noupstream', 'Nia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10, upstreamSyncedAt: null });
    await seedTick({
      ...KEY,
      userId: 'u-noupstream',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
      kilterId: 'pushed-log-uuid',
      kilterSyncedAt: '2020-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(1); // upstream_synced_at NULL → not absorbed
    expect(Number(row.total)).toBe(11);
  });

  it('user with one absorbed AND one fresh native tick still counts (not ALL absorbed)', async () => {
    // A user only drops out when EVERY one of their native sends is absorbed.
    // One still-fresh push keeps them in the count.
    await seedUser('u-both', 'Bo');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, {
      upstream: 10,
      upstreamSyncedAt: '2026-03-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-both',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
      kilterId: 'absorbed-log',
      kilterSyncedAt: '2026-02-01 00:00:00', // absorbed
    });
    await seedTick({
      ...KEY,
      userId: 'u-both',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-02-28 00:00:00',
      kilterId: 'fresh-log',
      kilterSyncedAt: '2026-02-28 12:00:00', // fresh
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(1); // one unabsorbed native send → counts
    expect(Number(row.total)).toBe(11);
  });

  it('single-key recompute applies the same absorption rule as bulk', async () => {
    await seedUser('u-abs-single', 'Sol');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, {
      upstream: 10,
      upstreamSyncedAt: '2026-03-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-abs-single',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
      kilterId: 'pushed-log-uuid',
      kilterSyncedAt: '2026-02-01 00:00:00', // absorbed
    });

    await recomputeClimbStatsCore(db, KEY.boardType, KEY.climbUuid, KEY.angle);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs)).toBe(0); // absorbed → single-key path drops it too
    expect(Number(row.total)).toBe(10);
  });

  it('non-owned climb NEVER derives FA from ticks (native or imported) — stays NULL', async () => {
    await seedUser('u-import', 'Ivan');
    await seedUser('u-native', 'Nadia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null); // non-owned (user_id NULL)
    // No upstream FA (MoonBoard shape): fa_username NULL.
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 100, faUsername: null });
    await seedTick({
      ...KEY,
      userId: 'u-import',
      status: 'send',
      origin: 'json_import',
      climbedAt: '2020-01-01 00:00:00',
    });
    await seedTick({ ...KEY, userId: 'u-native', status: 'send', origin: 'native', climbedAt: '2026-01-01 00:00:00' });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    // The manufacturer owns FA on non-owned climbs; no tick crowns it. MoonBoard
    // (no upstream FA) correctly stays NULL.
    expect(row.fa).toBe(null);
    expect(row.fa_at).toBe(null);
  });

  it('non-owned climb preserves an upstream-supplied FA verbatim (tick does not overwrite)', async () => {
    await seedUser('u-native', 'Nadia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null); // non-owned
    // Upstream (manufacturer) FA already present, with its own timestamp that
    // does NOT coincide with any tick's climbed_at.
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, {
      upstream: 100,
      faUsername: 'Upstream Setter',
      faAt: '1999-05-05 12:00:00',
    });
    await seedTick({ ...KEY, userId: 'u-native', status: 'send', origin: 'native', climbedAt: '2026-01-01 00:00:00' });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    // FA untouched — the recompute never derives or fills FA on non-owned climbs.
    expect(row.fa).toBe('Upstream Setter');
    // The native tick still counts toward the Boardsesh ascensionist count.
    expect(Number(row.bs)).toBe(1);
    expect(Number(row.total)).toBe(101);
  });

  it('owned climb still derives FA from the earliest tick of any origin', async () => {
    await seedUser('u-early', 'Erin');
    await seedUser('u-late', 'Liam');
    await seedClimb(KEY.boardType, KEY.climbUuid, 'u-early'); // owned
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 0, faUsername: null });
    await seedTick({ ...KEY, userId: 'u-early', status: 'send', origin: 'native', climbedAt: '2024-01-01 00:00:00' });
    await seedTick({ ...KEY, userId: 'u-late', status: 'send', origin: 'native', climbedAt: '2025-01-01 00:00:00' });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(row.fa).toBe('Erin'); // earliest sender crowns an owned climb
  });

  it('owned climb excludes quality = 0 ticks from the quality average', async () => {
    await seedUser('u-a', 'Ana');
    await seedUser('u-b', 'Bob');
    await seedClimb(KEY.boardType, KEY.climbUuid, 'u-a'); // owned by Ana
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 0 });
    await seedTick({
      ...KEY,
      userId: 'u-a',
      status: 'send',
      origin: 'native',
      quality: 0,
      climbedAt: '2026-01-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-b',
      status: 'send',
      origin: 'native',
      quality: 5,
      climbedAt: '2026-01-02 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    // The 0-quality tick is a legacy sentinel — average is 5, not (0+5)/2.
    expect(Number(row.quality)).toBe(5);
    expect(Number(row.bs)).toBe(2); // both native senders count
  });

  // --- Quality blend (the PR3 change) ---

  it('native rated tick blends into a non-owned climb’s quality_average', async () => {
    await seedUser('u-native', 'Nadia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null); // non-owned
    // Post-0168 shape: upstream quality 4.0 across 10 upstream ascents.
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10, upstreamQuality: 4 });
    await seedTick({
      ...KEY,
      userId: 'u-native',
      status: 'send',
      origin: 'native',
      quality: 2,
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    // blend = (4*10 + 2) / (10 + 1) = 42/11.
    expect(Number(row.quality)).toBeCloseTo(42 / 11, 6);
    expect(Number(row.upstream_quality)).toBe(4); // upstream term preserved
    expect(Number(row.bs_quality_sum)).toBe(2);
    expect(Number(row.bs_quality_count)).toBe(1);
  });

  it('imported rated tick does NOT blend (already inside upstream_quality_average)', async () => {
    await seedUser('u-import', 'Ivan');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10, upstreamQuality: 4 });
    await seedTick({
      ...KEY,
      userId: 'u-import',
      status: 'send',
      origin: 'json_import',
      quality: 1,
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    // Imported rating excluded → quality_average stays the pure upstream 4.0.
    expect(Number(row.quality)).toBeCloseTo(4, 6);
    expect(row.bs_quality_sum).toBe(null);
    expect(row.bs_quality_count).toBe(null);
  });

  it('a climber re-ticking counts only their LATEST rating (no vote multiplication)', async () => {
    await seedUser('u-native', 'Nadia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10, upstreamQuality: 4 });
    // Same user, two native rated sends — the later (quality 5) is the vote.
    await seedTick({
      ...KEY,
      userId: 'u-native',
      status: 'send',
      origin: 'native',
      quality: 2,
      climbedAt: '2026-01-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-native',
      status: 'send',
      origin: 'native',
      quality: 5,
      climbedAt: '2026-06-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs_quality_sum)).toBe(5); // latest rating only
    expect(Number(row.bs_quality_count)).toBe(1); // one voter
    // blend = (4*10 + 5) / (10 + 1) = 45/11.
    expect(Number(row.quality)).toBeCloseTo(45 / 11, 6);
  });

  it('a rated ATTEMPT never votes — only flash/send ticks feed bs_quality', async () => {
    await seedUser('u-native', 'Nadia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10, upstreamQuality: 4 });
    // A native attempt carrying a rating (odd but possible): excluded by the
    // status IN ('flash','send') filter — no Boardsesh vote materializes.
    await seedTick({
      ...KEY,
      userId: 'u-native',
      status: 'attempt',
      origin: 'native',
      quality: 5,
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(row.bs_quality_sum).toBe(null);
    expect(row.bs_quality_count).toBe(null);
    // quality_average stays the pure upstream 4.0 — an attempt's stars don't blend.
    expect(Number(row.quality)).toBeCloseTo(4, 6);
  });

  it('two rated sends sharing climbed_at tie-break on id DESC (later insert wins)', async () => {
    await seedUser('u-native', 'Nadia');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 10, upstreamQuality: 4 });
    // Same user, same climbed_at second — only the serial id orders them. The
    // second insert (quality 5) has the higher id, so `climbed_at DESC, id DESC`
    // must pick it; an id ASC (or unordered) implementation would pick the 2.
    const sharedClimbedAt = '2026-03-01 12:00:00';
    await seedTick({
      ...KEY,
      userId: 'u-native',
      status: 'send',
      origin: 'native',
      quality: 2,
      climbedAt: sharedClimbedAt,
    });
    await seedTick({
      ...KEY,
      userId: 'u-native',
      status: 'send',
      origin: 'native',
      quality: 5,
      climbedAt: sharedClimbedAt,
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    expect(Number(row.bs_quality_sum)).toBe(5); // higher-id tick wins the tie
    expect(Number(row.bs_quality_count)).toBe(1);
    expect(Number(row.quality)).toBeCloseTo(45 / 11, 6);
  });

  it('owned climb keeps the plain AVG (blend never applies)', async () => {
    await seedUser('u-a', 'Ana');
    await seedUser('u-b', 'Bob');
    await seedClimb(KEY.boardType, KEY.climbUuid, 'u-a'); // owned
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 0, upstreamQuality: null });
    await seedTick({
      ...KEY,
      userId: 'u-a',
      status: 'send',
      origin: 'native',
      quality: 2,
      climbedAt: '2026-01-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-b',
      status: 'send',
      origin: 'native',
      quality: 4,
      climbedAt: '2026-01-02 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    // Plain AVG(2, 4) = 3 — NOT a blend against any upstream term.
    expect(Number(row.quality)).toBeCloseTo(3, 6);
    // The blend-input columns are NULL for owned climbs — they're never blended,
    // so the columns carry one consistent meaning (non-owned only).
    expect(row.bs_quality_sum).toBe(null);
    expect(row.bs_quality_count).toBe(null);
  });

  it('non-owned climb the manufacturer never rated becomes the pure Boardsesh average', async () => {
    await seedUser('u-a', 'Ana');
    await seedUser('u-b', 'Bob');
    await seedClimb(KEY.boardType, KEY.climbUuid, null); // non-owned, no upstream quality
    // MoonBoard shape: community repeats but no catalog quality (upstream_quality NULL).
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 50, upstreamQuality: null });
    await seedTick({
      ...KEY,
      userId: 'u-a',
      status: 'flash',
      origin: 'native',
      quality: 3,
      climbedAt: '2026-01-01 00:00:00',
    });
    await seedTick({
      ...KEY,
      userId: 'u-b',
      status: 'send',
      origin: 'native',
      quality: 5,
      climbedAt: '2026-01-02 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [KEY]);

    const row = await statsRow(KEY.boardType, KEY.climbUuid, KEY.angle);
    // upstream term drops out (upstream_quality NULL) → pure Boardsesh (3+5)/2 = 4.
    expect(Number(row.quality)).toBeCloseTo(4, 6);
    expect(row.upstream_quality).toBe(null);
    expect(Number(row.bs_quality_sum)).toBe(8);
    expect(Number(row.bs_quality_count)).toBe(2);
  });

  it('single-key and bulk agree on the blended quality_average', async () => {
    await seedUser('u-native', 'Nadia');
    async function seedBlendFixture(uuid: string) {
      await seedClimb(KEY.boardType, uuid, null);
      await seedStats(KEY.boardType, uuid, KEY.angle, { upstream: 7, upstreamQuality: 3 });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-native',
        status: 'send',
        origin: 'native',
        quality: 5,
        climbedAt: '2026-03-01 00:00:00',
      });
    }
    await seedBlendFixture('CLIMB-SINGLE-Q');
    await seedBlendFixture('CLIMB-BULK-Q');

    await recomputeClimbStatsCore(db, KEY.boardType, 'CLIMB-SINGLE-Q', KEY.angle);
    await recomputeClimbStatsBulk(db, [{ boardType: KEY.boardType, climbUuid: 'CLIMB-BULK-Q', angle: KEY.angle }]);

    const single = await statsRow(KEY.boardType, 'CLIMB-SINGLE-Q', KEY.angle);
    const bulk = await statsRow(KEY.boardType, 'CLIMB-BULK-Q', KEY.angle);
    // blend = (3*7 + 5) / (7 + 1) = 26/8 = 3.25.
    expect(Number(single.quality)).toBeCloseTo(26 / 8, 6);
    expect(Number(bulk.quality)).toBeCloseTo(Number(single.quality), 9);
    expect(Number(bulk.bs_quality_sum)).toBe(Number(single.bs_quality_sum));
    expect(Number(bulk.bs_quality_count)).toBe(Number(single.bs_quality_count));
  });

  it('single-key recompute produces the same counting result and returns a diff', async () => {
    await seedUser('u-native', 'Nadia');
    await seedUser('u-pull', 'Pedro');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
    await seedStats(KEY.boardType, KEY.climbUuid, KEY.angle, { upstream: 5 });
    await seedTick({ ...KEY, userId: 'u-native', status: 'send', origin: 'native', climbedAt: '2026-01-01 00:00:00' });
    await seedTick({
      ...KEY,
      userId: 'u-pull',
      status: 'flash',
      origin: 'kilter_pull',
      climbedAt: '2026-01-02 00:00:00',
    });

    const diff = await recomputeClimbStatsCore(db, KEY.boardType, KEY.climbUuid, KEY.angle);

    expect(diff).toBeDefined();
    expect(Number(diff?.new_bs)).toBe(1); // only the native user
    expect(Number(diff?.new_total)).toBe(6); // upstream 5 + 1
  });

  it('bulk and single-key produce IDENTICAL rows for the same input', async () => {
    // A mixed provenance fixture covering every code path: a native sender, an
    // aurora-pull-only user (excluded), a mixed user (excluded), and a rated
    // tick — on an OWNED climb so FA/quality/difficulty derivation runs too.
    async function seedFixture(uuid: string, ownerUserId: string | null) {
      await seedClimb(KEY.boardType, uuid, ownerUserId);
      await seedStats(KEY.boardType, uuid, KEY.angle, { upstream: 7, faUsername: null });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-native',
        status: 'send',
        origin: 'native',
        quality: 4,
        difficulty: 12,
        climbedAt: '2026-03-01 00:00:00',
      });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-pull',
        status: 'flash',
        origin: 'kilter_pull',
        climbedAt: '2026-02-01 00:00:00',
      });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-mixed',
        status: 'send',
        origin: 'native',
        quality: 2,
        difficulty: 10,
        climbedAt: '2026-04-01 00:00:00',
      });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-mixed',
        status: 'send',
        origin: 'json_import',
        climbedAt: '2026-01-15 00:00:00',
      });
    }

    await seedUser('u-native', 'Nadia');
    await seedUser('u-pull', 'Pedro');
    await seedUser('u-mixed', 'Mika');
    await seedFixture('CLIMB-SINGLE', 'u-native');
    await seedFixture('CLIMB-BULK', 'u-native');

    await recomputeClimbStatsCore(db, KEY.boardType, 'CLIMB-SINGLE', KEY.angle);
    await recomputeClimbStatsBulk(db, [{ boardType: KEY.boardType, climbUuid: 'CLIMB-BULK', angle: KEY.angle }]);

    const single = await statsRow(KEY.boardType, 'CLIMB-SINGLE', KEY.angle);
    const bulk = await statsRow(KEY.boardType, 'CLIMB-BULK', KEY.angle);

    // Same counting, FA, quality — the single-key and set-based paths must agree.
    expect({
      bs: Number(bulk.bs),
      total: Number(bulk.total),
      fa: bulk.fa,
      fa_at: bulk.fa_at,
      quality: Number(bulk.quality),
    }).toEqual({
      bs: Number(single.bs),
      total: Number(single.total),
      fa: single.fa,
      fa_at: single.fa_at,
      quality: Number(single.quality),
    });
    // Sanity: only the all-native sender counts (u-pull pull-only and u-mixed
    // mixed are both excluded), so bs=1. FA on an OWNED climb is the earliest
    // flash/send tick of ANY origin — Mika's json_import tick (2026-01-15) —
    // which is independent of who counts toward the ascensionist total.
    expect(Number(single.bs)).toBe(1);
    expect(Number(single.total)).toBe(8); // upstream 7 + 1 native
    expect(single.fa).toBe('Mika');
  });

  // -------------------------------------------------------------------------
  // Defensive-seed guard (#3528)
  //
  // A tick can name any string as its climb_uuid, so the seed must not mint a
  // board_climb_stats row for a climb that doesn't exist. These assert the
  // BEHAVIOUR against real Postgres — deleting the guard in recompute.ts must
  // turn them red. (packages/db has no vitest project and nothing in CI runs
  // its tsx --test suite, so a SQL-text assertion over there is a smoke test,
  // not evidence.)
  // -------------------------------------------------------------------------

  async function statsRowCount(boardType: string, uuid: string, angle: number): Promise<number> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n
        FROM board_climb_stats
       WHERE board_type = ${boardType} AND climb_uuid = ${uuid} AND angle = ${angle}
    `)) as unknown as Array<{ n: number }>;
    const [row] = Array.isArray(rows) ? rows : (rows as { rows: Array<{ n: number }> }).rows;
    return Number(row.n);
  }

  it('single-key: a tick on a climb missing from board_climbs seeds NO stats row', async () => {
    await seedUser('u-ghost', 'Gia');
    // Deliberately no seedClimb — this is the phantom-UUID case.
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'CLIMB-GHOST',
      angle: 40,
      userId: 'u-ghost',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    const diff = await recomputeClimbStatsCore(db, 'kilter', 'CLIMB-GHOST', 40);

    expect(await statsRowCount('kilter', 'CLIMB-GHOST', 40)).toBe(0);
    // No row to update → the documented "UPDATE matched no row" path. Must be a
    // quiet undefined, not a throw: the debounced publisher logs any throw as an
    // error, and this is an expected outcome rather than a failure.
    expect(diff).toBeUndefined();
  });

  it('bulk: a phantom key in a chunk seeds nothing and does not disturb the real key beside it', async () => {
    await seedUser('u-mixed-chunk', 'Mo');
    await seedClimb('kilter', 'CLIMB-REAL', null);
    await seedStats('kilter', 'CLIMB-REAL', 40, { upstream: 3 });
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'CLIMB-REAL',
      angle: 40,
      userId: 'u-mixed-chunk',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'CLIMB-GHOST',
      angle: 40,
      userId: 'u-mixed-chunk',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [
      { boardType: 'kilter', climbUuid: 'CLIMB-GHOST', angle: 40 },
      { boardType: 'kilter', climbUuid: 'CLIMB-REAL', angle: 40 },
    ]);

    expect(await statsRowCount('kilter', 'CLIMB-GHOST', 40)).toBe(0);
    // The guard must drop the phantom key WITHOUT collateral damage: the real
    // key in the same chunk still counts correctly.
    const real = await statsRow('kilter', 'CLIMB-REAL', 40);
    expect(Number(real.bs)).toBe(1);
    expect(Number(real.total)).toBe(4); // upstream 3 + 1 native
  });

  // KEEP: this passes both with and without the guard — it is not redundant, it
  // is the tripwire against over-guarding. The seed exists precisely so a tick
  // at an angle the catalog has no stats row for still gets one. Anyone who
  // "hardens" the guard from (climb) to (climb, angle) breaks real ticks, and
  // this is the test that tells them.
  it('a real climb ticked at an angle with no stats row STILL seeds one', async () => {
    await seedUser('u-newangle', 'Nia');
    await seedClimb('kilter', 'CLIMB-ANGLES', null);
    await seedStats('kilter', 'CLIMB-ANGLES', 40, { upstream: 5 });
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'CLIMB-ANGLES',
      angle: 25,
      userId: 'u-newangle',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'kilter', 'CLIMB-ANGLES', 25);

    const seeded = await statsRow('kilter', 'CLIMB-ANGLES', 25);
    expect(Number(seeded.bs)).toBe(1);
    expect(Number(seeded.total)).toBe(1); // no upstream at 25° — 0 + 1 native
  });

  it('seeded rows are marked quality_normalized (the #3529 seed half)', async () => {
    async function normalizedFlags(uuid: string, angle: number): Promise<boolean[]> {
      const rows = (await db.execute(sql`
        SELECT quality_normalized AS flag
          FROM board_climb_stats
         WHERE board_type = 'kilter' AND climb_uuid = ${uuid} AND angle = ${angle}
      `)) as unknown as Array<{ flag: boolean }>;
      const list = Array.isArray(rows) ? rows : (rows as { rows: Array<{ flag: boolean }> }).rows;
      return list.map((entry) => entry.flag);
    }

    await seedUser('u-norm', 'Nils');
    // Non-owned climbs (user_id null) — the branch that PRESERVES the seeded
    // flag verbatim, so the seed's value is the value forever. Owned climbs
    // self-heal via the owned branch's `quality_normalized = TRUE`.
    await seedClimb('kilter', 'CLIMB-NORM-SINGLE', null);
    await seedClimb('kilter', 'CLIMB-NORM-BULK', null);
    for (const uuid of ['CLIMB-NORM-SINGLE', 'CLIMB-NORM-BULK']) {
      await seedTick({
        boardType: 'kilter',
        climbUuid: uuid,
        angle: 30,
        userId: 'u-norm',
        status: 'send',
        origin: 'native',
        quality: 4,
        climbedAt: '2026-01-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, 'kilter', 'CLIMB-NORM-SINGLE', 30);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: 'CLIMB-NORM-BULK', angle: 30 }]);

    expect(await normalizedFlags('CLIMB-NORM-SINGLE', 30)).toEqual([true]);
    expect(await normalizedFlags('CLIMB-NORM-BULK', 30)).toEqual([true]);
  });
});
