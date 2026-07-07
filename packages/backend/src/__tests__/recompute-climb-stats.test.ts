import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { recomputeClimbStats as recomputeClimbStatsCore, recomputeClimbStatsBulk } from '@boardsesh/db/queries';
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

  it('seeds the stats row with explicit upstream=0 and boardsesh=0', async () => {
    let capturedSeedValues: unknown = null;
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const insertChain = {
        onConflictDoNothing: vi.fn(),
      };
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn((values: unknown) => {
            capturedSeedValues = values;
            return insertChain;
          }),
        })),
        execute: vi.fn(async () => []),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    expect(capturedSeedValues).toMatchObject({
      boardType: 'kilter',
      climbUuid: 'CLIMB-1',
      angle: 40,
      ascensionistCount: 0,
      upstreamAscensionistCount: 0,
      boardseshAscensionistCount: 0,
    });
  });

  it('runs the recompute SQL inside a single transaction', async () => {
    let executeCount = 0;
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })),
        })),
        execute: vi.fn(async () => {
          executeCount += 1;
          return [];
        }),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(executeCount).toBe(1);
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
        insert: vi.fn(() => ({
          values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })),
        })),
        execute: vi.fn(async (query: unknown) => {
          capturedQuery = query;
          return [];
        }),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    type DrizzleSql = { queryChunks?: Array<unknown> };
    const chunks = (capturedQuery as DrizzleSql).queryChunks ?? [];
    const sql = chunks
      .filter((c): c is { value?: string[] } => typeof c === 'object' && c !== null)
      .flatMap((c) => c.value ?? [])
      .join('');

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
        insert: vi.fn(() => ({
          values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })),
        })),
        execute: vi.fn(async (query: unknown) => {
          capturedQuery = query;
          return [];
        }),
      };
      await callback(tx);
    });

    await recomputeClimbStats('kilter', 'CLIMB-1', 40);

    type DrizzleSql = { queryChunks?: Array<unknown> };
    const chunks = (capturedQuery as DrizzleSql).queryChunks ?? [];
    const sql = chunks
      .filter((c): c is { value?: string[] } => typeof c === 'object' && c !== null)
      .flatMap((c) => c.value ?? [])
      .join('');

    // The agg CTE must compute the averages — Postgres AVG skips NULL inputs,
    // so a single rated tick is enough to populate the column. quality = 0 is a
    // legacy sentinel, excluded via NULLIF so it never drags the average down.
    expect(sql).toMatch(/AVG\(NULLIF\(bt\.quality, 0\)\)\s+AS avg_quality/);
    expect(sql).toMatch(/AVG\(bt\.difficulty\)\s+AS avg_difficulty/);

    // Each rating column must be guarded by the same boardsesh_owned CASE
    // expression used for FA, so Aurora's averages survive untouched on
    // Aurora-synced climbs.
    expect(sql).toMatch(/quality_average\s*=\s*CASE[\s\S]+?agg\.avg_quality[\s\S]+?s\.quality_average/);
    expect(sql).toMatch(/difficulty_average\s*=\s*CASE[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.difficulty_average/);
    expect(sql).toMatch(/display_difficulty\s*=\s*CASE[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.display_difficulty/);
  });

  it('emits a [recomputeClimbStats] info log line with prev/new diff when a row was updated', async () => {
    const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })),
        })),
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
        insert: vi.fn(() => ({
          values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })),
        })),
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
          insert: vi.fn(() => ({
            values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })),
          })),
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
    opts: { upstream?: number; faUsername?: string | null; faAt?: string | null } = {},
  ) {
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, upstream_ascensionist_count, ascensionist_count, boardsesh_ascensionist_count, fa_username, fa_at)
      VALUES (${boardType}, ${uuid}, ${angle}, ${opts.upstream ?? 0}, ${opts.upstream ?? 0}, 0, ${opts.faUsername ?? null}, ${opts.faAt ?? null})
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
  };

  async function seedTick(t: SeedTick) {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count, quality, difficulty, climbed_at, created_at, updated_at, kilter_id)
      VALUES (gen_random_uuid()::text, ${t.userId}, ${t.boardType}, ${t.climbUuid}, ${t.angle}, ${t.status}::tick_status, ${t.origin}::tick_origin, 1, ${t.quality ?? null}, ${t.difficulty ?? null}, ${t.climbedAt}, now(), now(), ${t.kilterId ?? null})
    `);
  }

  async function statsRow(boardType: string, uuid: string, angle: number) {
    const rows = (await db.execute(sql`
      SELECT boardsesh_ascensionist_count AS bs, ascensionist_count AS total, fa_username AS fa, fa_at AS fa_at, quality_average AS quality
        FROM board_climb_stats
       WHERE board_type = ${boardType} AND climb_uuid = ${uuid} AND angle = ${angle}
    `)) as unknown as Array<{
      bs: number | string | null;
      total: number | string | null;
      fa: string | null;
      fa_at: string | null;
      quality: number | string | null;
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

  it('pushed-native tick (kilter_id set, origin native) KEEPS counting', async () => {
    await seedUser('u-push', 'Priya');
    await seedClimb(KEY.boardType, KEY.climbUuid, null);
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
    expect(Number(row.bs)).toBe(1); // origin still native → counts despite kilter_id
    expect(Number(row.total)).toBe(11);
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
});
