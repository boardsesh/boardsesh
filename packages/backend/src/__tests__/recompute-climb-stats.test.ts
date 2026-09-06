import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * The DSM guard `recomputeClimbStats` sets as the first statement of its
 * transaction (#4235, Sentry BOARDSESH-B6). The aggregate below hash-joins
 * `boardsesh_ticks` against `board_climb_stats`, the plan shape that exhausts
 * Postgres's dynamic shared memory on our small /dev/shm.
 */
const GUARD_PATTERN = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

/**
 * The #4798 one-time backfill, located by name rather than by number so the
 * migration-renumber bot can move it freely. Returns the SQL statements, or an
 * empty array when the migration has not been generated yet — the test below
 * skips with an explanation in that case rather than failing.
 */
function readBackfillMigrationStatements(): string[] {
  const drizzleDir = fileURLToPath(new URL('../../../db/drizzle/', import.meta.url));
  let fileNames: string[];
  try {
    fileNames = readdirSync(drizzleDir);
  } catch {
    return [];
  }
  const backfill = fileNames.find((name) => name.endsWith('_backfill_tick_graded_climb_stats.sql'));
  if (!backfill) return [];
  return readFileSync(join(drizzleDir, backfill), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const BACKFILL_STATEMENTS = readBackfillMigrationStatements();

describe('recomputeClimbStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The seed's behaviour is asserted end to end against real Postgres in the
  // provenance-matrix block below (a phantom key seeds nothing; a real climb at
  // a new angle still does; quality_normalized). What this one pins is the
  // SHAPE: the seed must stay an INSERT ... SELECT FROM board_climbs with the
  // correlated qualifying-tick EXISTS. A regression to a plain VALUES insert
  // — which cannot carry either guard — silently reintroduces phantom rows.
  it('seeds only through a real climb with a matching non-detached send/flash tick', async () => {
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

    // Guard + seed + aggregate. Asserted before indexing so a mock that never
    // invoked the transaction callback fails as "0 statements" rather than as
    // an undefined-index error inside sqlText.
    expect(executed).toHaveLength(3);
    // The guard has to come FIRST: `SET LOCAL` only covers statements that run
    // after it in the same transaction, so a seed or aggregate ahead of it
    // would still plan a parallel hash join (#4235).
    expect(sqlText(executed[0])).toMatch(GUARD_PATTERN);
    const seedSql = sqlText(executed[1]);
    expect(seedSql).toContain('INSERT INTO board_climb_stats');
    expect(seedSql).toMatch(/SELECT[\s\S]*FROM board_climbs bc/);
    expect(seedSql).toMatch(/WHERE bc\.uuid =/);
    expect(seedSql).toMatch(/AND bc\.board_type =/);
    expect(seedSql).toContain('FROM boardsesh_ticks seed_tick');
    expect(seedSql).toContain("seed_tick.status IN ('flash','send')");
    expect(seedSql).toContain('seed_tick.kilter_detached_at IS NULL');
    expect(seedSql).toContain('quality_normalized');
    // MoonBoard wrong-angle guard (#3529). Behaviour is asserted against real
    // Postgres further down; what this pins is that the guard reads
    // board_climbs.angle from the OUTER FROM (the single-key seed's shape) and
    // tests for real catalog data rather than a bare stats row.
    expect(seedSql).toMatch(/bc\.angle IS NULL/);
    expect(seedSql).toMatch(/bc\.angle =/);
    expect(seedSql).toMatch(/COALESCE\(s\.upstream_ascensionist_count, 0\) > 0/);
    expect(seedSql).toMatch(/s\.upstream_quality_average IS NOT NULL/);
  });

  it('runs the guard, seed and recompute SQL inside one transaction', async () => {
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

    // One transaction, and only one — the guard rides the transaction this
    // path already opens rather than nesting a savepoint through
    // `withSerialPlan` just to run a `SET LOCAL` (#4235).
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // The DSM guard, the seed, then the aggregate recompute.
    expect(executed).toHaveLength(3);
    expect(sqlText(executed[0])).toMatch(GUARD_PATTERN);
    expect(executed.filter((statement) => GUARD_PATTERN.test(sqlText(statement)))).toHaveLength(1);
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

    // The aggregate rejects sentinel/impossible values instead of letting them
    // drag an owned climb's averages out of range.
    expect(sql).toMatch(/AVG\(bt\.quality\) FILTER \(WHERE bt\.quality BETWEEN 1 AND 5\)\s+AS avg_quality/);
    expect(sql).toMatch(/AVG\(bt\.difficulty\) FILTER \(WHERE bt\.difficulty > 1\)\s+AS avg_difficulty/);

    // difficulty/display are CASE-guarded on `owned OR derive_from_ticks`
    // (#4798): Aurora's averages survive untouched on a synced climb, while a
    // row we have never graded — or one we graded ourselves and upstream has not
    // stamped since — takes the tick average.
    expect(sql).toMatch(
      /difficulty_average\s*=\s*CASE[\s\S]+?boardsesh_owned FROM owner[\s\S]+?derive_from_ticks FROM grade_source[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.difficulty_average/,
    );
    expect(sql).toMatch(
      /display_difficulty\s*=\s*CASE[\s\S]+?boardsesh_owned FROM owner[\s\S]+?derive_from_ticks FROM grade_source[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.display_difficulty/,
    );
    // The marker column is written on the same branch, stamped now() when the
    // derive produced a grade and NULLed when it did not (last graded tick gone).
    expect(sql).toMatch(
      /tick_graded_at\s*=\s*CASE[\s\S]+?derive_from_ticks FROM grade_source[\s\S]+?agg\.avg_difficulty IS NULL THEN NULL ELSE \(now\(\) AT TIME ZONE 'UTC'\)[\s\S]+?s\.tick_graded_at/,
    );
    // The derive predicate itself: no grade to protect, or a grade carrying our
    // marker. Marker PRESENCE, never a timestamp race against upstream_synced_at
    // — kilter-sync stamps that on every pass, so comparing them froze grades we
    // owned the moment a pass shipped no display difficulty.
    expect(sql).toMatch(/grade_source AS \([\s\S]+?s\.display_difficulty IS NULL/);
    expect(sql).toMatch(/s\.tick_graded_at IS NOT NULL/);
    expect(sql).not.toMatch(/tick_graded_at\s*>\s*\S*upstream_synced_at/);
    // MoonBoard is fenced out of both non-owned legs — an ungraded MoonBoard
    // catalog row belongs to the Moon-catalog repair scripts, not to us.
    expect(sql).toMatch(/grade_source AS \([\s\S]+?s\.board_type <> 'moonboard'/);
    // UTC wall time, not bare now(): the marker is compared against
    // upstream_synced_at, which upstream writers store as a JS ISO string.
    expect(sql).toContain("now() AT TIME ZONE 'UTC'");

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
    expect(sql).toContain('bt.quality <= 5');
    expect(sql).toMatch(/bs_quality AS \([\s\S]*?bt\.quality <= 5\s+AND bt\.kilter_detached_at IS NULL\s+ORDER BY/);
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

  // `angle` is the MoonBoard-shaped case (#3529): the catalog mints one
  // board_climbs row per (problem, angle), so those rows carry a non-null angle.
  // Kilter/Tension catalog rows leave it null, which is why it defaults to null.
  async function seedClimb(boardType: string, uuid: string, ownerUserId: string | null, angle: number | null = null) {
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, user_id, angle)
      VALUES (${uuid}, ${boardType}, 1, 'setter', 'Test Climb', '', 'p1r1', true, ${ownerUserId}, ${angle})
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
      // Grade provenance (#4798). A catalog-graded row carries a grade with
      // tickGradedAt null; a row we graded from ticks carries both.
      displayDifficulty?: number | null;
      difficultyAverage?: number | null;
      tickGradedAt?: string | null;
    } = {},
  ) {
    const upstreamQuality = opts.upstreamQuality ?? null;
    const displayDifficulty = opts.displayDifficulty ?? null;
    // Catalog rows carry the same number in both grade columns unless a test
    // deliberately separates them.
    const difficultyAverage = opts.difficultyAverage ?? displayDifficulty;
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, upstream_ascensionist_count, ascensionist_count, boardsesh_ascensionist_count, fa_username, fa_at, quality_average, upstream_quality_average, quality_normalized, upstream_synced_at, display_difficulty, difficulty_average, tick_graded_at)
      VALUES (${boardType}, ${uuid}, ${angle}, ${opts.upstream ?? 0}, ${opts.upstream ?? 0}, 0, ${opts.faUsername ?? null}, ${opts.faAt ?? null}, ${upstreamQuality}, ${upstreamQuality}, true, ${opts.upstreamSyncedAt ?? null}, ${displayDifficulty}, ${difficultyAverage}, ${opts.tickGradedAt ?? null})
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
    kilterDetachedAt?: string | null;
  };

  async function seedTick(t: SeedTick) {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, origin, attempt_count, quality, difficulty, climbed_at, created_at, updated_at, kilter_id, kilter_synced_at, kilter_detached_at)
      VALUES (gen_random_uuid()::text, ${t.userId}, ${t.boardType}, ${t.climbUuid}, ${t.angle}, ${t.status}::tick_status, ${t.origin}::tick_origin, 1, ${t.quality ?? null}, ${t.difficulty ?? null}, ${t.climbedAt}, now(), now(), ${t.kilterId ?? null}, ${t.kilterSyncedAt ?? null}, ${t.kilterDetachedAt ?? null})
    `);
  }

  async function statsRow(boardType: string, uuid: string, angle: number) {
    const rows = (await db.execute(sql`
      SELECT upstream_ascensionist_count AS upstream, boardsesh_ascensionist_count AS bs,
             ascensionist_count AS total, fa_username AS fa, fa_at AS fa_at,
             quality_average AS quality, upstream_quality_average AS upstream_quality,
             boardsesh_quality_sum AS bs_quality_sum, boardsesh_quality_count AS bs_quality_count,
             difficulty_average AS difficulty, display_difficulty AS display_difficulty,
             tick_graded_at AS tick_graded_at
        FROM board_climb_stats
       WHERE board_type = ${boardType} AND climb_uuid = ${uuid} AND angle = ${angle}
    `)) as unknown as Array<{
      upstream: number | string | null;
      bs: number | string | null;
      total: number | string | null;
      fa: string | null;
      fa_at: string | null;
      quality: number | string | null;
      upstream_quality: number | string | null;
      bs_quality_sum: number | string | null;
      bs_quality_count: number | string | null;
      difficulty: number | string | null;
      display_difficulty: number | string | null;
      tick_graded_at: string | Date | null;
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

  it('single + bulk: deleting the last send clears Boardsesh stats but retains upstream count/quality', async () => {
    await seedUser('u-last-send', 'Lena');
    for (const uuid of ['CLIMB-LAST-SINGLE', 'CLIMB-LAST-BULK']) {
      await seedClimb(KEY.boardType, uuid, null);
      await seedStats(KEY.boardType, uuid, KEY.angle, { upstream: 7, upstreamQuality: 4 });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-last-send',
        status: 'send',
        origin: 'native',
        quality: 5,
        climbedAt: '2026-03-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, KEY.boardType, 'CLIMB-LAST-SINGLE', KEY.angle);
    await recomputeClimbStatsBulk(db, [{ boardType: KEY.boardType, climbUuid: 'CLIMB-LAST-BULK', angle: KEY.angle }]);
    await db.execute(sql`
      DELETE FROM boardsesh_ticks
       WHERE board_type = ${KEY.boardType}
         AND climb_uuid IN ('CLIMB-LAST-SINGLE', 'CLIMB-LAST-BULK')
         AND angle = ${KEY.angle}
    `);

    await recomputeClimbStatsCore(db, KEY.boardType, 'CLIMB-LAST-SINGLE', KEY.angle);
    await recomputeClimbStatsBulk(db, [{ boardType: KEY.boardType, climbUuid: 'CLIMB-LAST-BULK', angle: KEY.angle }]);

    for (const uuid of ['CLIMB-LAST-SINGLE', 'CLIMB-LAST-BULK']) {
      const row = await statsRow(KEY.boardType, uuid, KEY.angle);
      expect(Number(row.upstream)).toBe(7);
      expect(Number(row.bs)).toBe(0);
      expect(Number(row.total)).toBe(7);
      expect(Number(row.upstream_quality)).toBe(4);
      expect(Number(row.quality)).toBe(4);
      expect(row.bs_quality_sum).toBe(null);
      expect(row.bs_quality_count).toBe(null);
    }
  });

  it('single + bulk: detaching the last rated send clears Boardsesh stats but retains upstream terms', async () => {
    await seedUser('u-last-attached', 'Della');
    for (const uuid of ['CLIMB-DETACH-SINGLE', 'CLIMB-DETACH-BULK']) {
      await seedClimb(KEY.boardType, uuid, null);
      await seedStats(KEY.boardType, uuid, KEY.angle, { upstream: 7, upstreamQuality: 4 });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-last-attached',
        status: 'send',
        origin: 'native',
        quality: 5,
        climbedAt: '2026-03-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, KEY.boardType, 'CLIMB-DETACH-SINGLE', KEY.angle);
    await recomputeClimbStatsBulk(db, [{ boardType: KEY.boardType, climbUuid: 'CLIMB-DETACH-BULK', angle: KEY.angle }]);

    for (const uuid of ['CLIMB-DETACH-SINGLE', 'CLIMB-DETACH-BULK']) {
      const attached = await statsRow(KEY.boardType, uuid, KEY.angle);
      expect(Number(attached.upstream)).toBe(7);
      expect(Number(attached.bs)).toBe(1);
      expect(Number(attached.total)).toBe(8);
      expect(Number(attached.bs_quality_sum)).toBe(5);
      expect(Number(attached.bs_quality_count)).toBe(1);
      expect(Number(attached.quality)).toBeCloseTo(33 / 8, 6);
    }

    await db.execute(sql`
      UPDATE boardsesh_ticks
         SET kilter_detached_at = '2026-03-02 00:00:00'
       WHERE board_type = ${KEY.boardType}
         AND climb_uuid IN ('CLIMB-DETACH-SINGLE', 'CLIMB-DETACH-BULK')
         AND angle = ${KEY.angle}
    `);

    await recomputeClimbStatsCore(db, KEY.boardType, 'CLIMB-DETACH-SINGLE', KEY.angle);
    await recomputeClimbStatsBulk(db, [{ boardType: KEY.boardType, climbUuid: 'CLIMB-DETACH-BULK', angle: KEY.angle }]);

    for (const uuid of ['CLIMB-DETACH-SINGLE', 'CLIMB-DETACH-BULK']) {
      const detached = await statsRow(KEY.boardType, uuid, KEY.angle);
      expect(Number(detached.upstream)).toBe(7);
      expect(Number(detached.bs)).toBe(0);
      expect(Number(detached.total)).toBe(7);
      expect(Number(detached.upstream_quality)).toBe(4);
      expect(Number(detached.quality)).toBe(4);
      expect(detached.bs_quality_sum).toBe(null);
      expect(detached.bs_quality_count).toBe(null);
    }
  });

  it('single + bulk: owned averages defensively exclude legacy/impossible rating sentinels', async () => {
    await seedUser('u-valid-rating', 'Val');
    await seedUser('u-low-rating', 'Lo');
    await seedUser('u-high-rating', 'Hi');

    async function seedInvalidAverageFixture(uuid: string) {
      await seedClimb(KEY.boardType, uuid, 'u-valid-rating');
      await seedStats(KEY.boardType, uuid, KEY.angle, { upstream: 0 });
      // The production CHECK rejects quality 6. This intentionally reduced test
      // schema omits that constraint so the query-level defence stays covered for
      // legacy rows or fixtures loaded with constraints disabled.
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-valid-rating',
        status: 'send',
        origin: 'native',
        quality: 3,
        difficulty: 10,
        climbedAt: '2026-01-01 00:00:00',
      });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-low-rating',
        status: 'send',
        origin: 'native',
        quality: 0,
        difficulty: 0,
        climbedAt: '2026-01-02 00:00:00',
      });
      await seedTick({
        boardType: KEY.boardType,
        climbUuid: uuid,
        angle: KEY.angle,
        userId: 'u-high-rating',
        status: 'send',
        origin: 'native',
        quality: 6,
        difficulty: 1,
        climbedAt: '2026-01-03 00:00:00',
      });
    }

    await seedInvalidAverageFixture('CLIMB-GUARD-SINGLE');
    await seedInvalidAverageFixture('CLIMB-GUARD-BULK');
    await recomputeClimbStatsCore(db, KEY.boardType, 'CLIMB-GUARD-SINGLE', KEY.angle);
    await recomputeClimbStatsBulk(db, [{ boardType: KEY.boardType, climbUuid: 'CLIMB-GUARD-BULK', angle: KEY.angle }]);

    const single = await statsRow(KEY.boardType, 'CLIMB-GUARD-SINGLE', KEY.angle);
    const bulk = await statsRow(KEY.boardType, 'CLIMB-GUARD-BULK', KEY.angle);
    for (const row of [single, bulk]) {
      expect(Number(row.difficulty)).toBe(10);
      expect(Number(row.display_difficulty)).toBe(10);
      expect(Number(row.quality)).toBe(3);
    }
    expect(Number(bulk.difficulty)).toBe(Number(single.difficulty));
    expect(Number(bulk.display_difficulty)).toBe(Number(single.display_difficulty));
    expect(Number(bulk.quality)).toBe(Number(single.quality));
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

  it('single + bulk: a valid climb with no tick does not seed a stats row', async () => {
    await seedClimb('kilter', 'CLIMB-NO-TICK-SINGLE', null);
    await seedClimb('kilter', 'CLIMB-NO-TICK-BULK', null);

    await recomputeClimbStatsCore(db, 'kilter', 'CLIMB-NO-TICK-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: 'CLIMB-NO-TICK-BULK', angle: 40 }]);

    expect(await statsRowCount('kilter', 'CLIMB-NO-TICK-SINGLE', 40)).toBe(0);
    expect(await statsRowCount('kilter', 'CLIMB-NO-TICK-BULK', 40)).toBe(0);
  });

  it('single + bulk: attempt-only and detached-only keys do not seed stats rows', async () => {
    await seedUser('u-no-seed', 'Nora');
    const fixtures = [
      { uuid: 'CLIMB-ATTEMPT-SINGLE', mode: 'single' as const, status: 'attempt' as const },
      { uuid: 'CLIMB-ATTEMPT-BULK', mode: 'bulk' as const, status: 'attempt' as const },
      { uuid: 'CLIMB-DETACHED-SINGLE', mode: 'single' as const, status: 'send' as const },
      { uuid: 'CLIMB-DETACHED-BULK', mode: 'bulk' as const, status: 'send' as const },
    ];
    for (const fixture of fixtures) {
      await seedClimb('kilter', fixture.uuid, null);
      await seedTick({
        boardType: 'kilter',
        climbUuid: fixture.uuid,
        angle: 40,
        userId: 'u-no-seed',
        status: fixture.status,
        origin: 'native',
        climbedAt: '2026-01-01 00:00:00',
        kilterDetachedAt: fixture.uuid.includes('DETACHED') ? '2026-01-02 00:00:00' : null,
      });
      if (fixture.mode === 'single') {
        await recomputeClimbStatsCore(db, 'kilter', fixture.uuid, 40);
      } else {
        await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: fixture.uuid, angle: 40 }]);
      }
      expect(await statsRowCount('kilter', fixture.uuid, 40)).toBe(0);
    }
  });

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
  it('single + bulk: a real climb sent at an angle with no stats row STILL seeds one', async () => {
    await seedUser('u-newangle', 'Nia');
    for (const uuid of ['CLIMB-ANGLES-SINGLE', 'CLIMB-ANGLES-BULK']) {
      await seedClimb('kilter', uuid, null);
      await seedStats('kilter', uuid, 40, { upstream: 5, displayDifficulty: 20, upstreamSyncedAt: '2026-01-01' });
      await seedTick({
        boardType: 'kilter',
        climbUuid: uuid,
        angle: 25,
        userId: 'u-newangle',
        status: 'send',
        origin: 'native',
        difficulty: 16,
        climbedAt: '2026-01-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, 'kilter', 'CLIMB-ANGLES-SINGLE', 25);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: 'CLIMB-ANGLES-BULK', angle: 25 }]);

    for (const uuid of ['CLIMB-ANGLES-SINGLE', 'CLIMB-ANGLES-BULK']) {
      const seeded = await statsRow('kilter', uuid, 25);
      expect(Number(seeded.bs)).toBe(1);
      expect(Number(seeded.total)).toBe(1); // no upstream at 25° — 0 + 1 native
      // #4798: the seeded row had no grade, so the tick's grade fills it and
      // the row is marked as tick-graded. Without this the climb is invisible
      // to every grade filter at 25°.
      expect(Number(seeded.display_difficulty)).toBe(16);
      expect(Number(seeded.difficulty)).toBe(16);
      expect(seeded.tick_graded_at).not.toBeNull();

      // The catalog-graded 40° row is untouched — different key, upstream's grade.
      const graded = await statsRow('kilter', uuid, 40);
      expect(Number(graded.display_difficulty)).toBe(20);
      expect(graded.tick_graded_at).toBeNull();
    }
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

  // -------------------------------------------------------------------------
  // MoonBoard wrong-angle seed guard (#3529)
  //
  // MoonBoard identity is angle-bearing (one board_climbs row per problem AND
  // angle, each with a non-null board_climbs.angle), so a tick logged from a
  // board set to the other angle names a climb the catalog does not grade at
  // that angle. Seeding there mints a row nothing can render. This is the
  // defence-in-depth layer for ticks that did NOT come through saveTick:
  // pre-fix rows, bulk/self-heal recomputes over them, future importers.
  //
  // "Carries real catalog data" — not "a row exists" — is the whole predicate.
  // Every affected climb in prod already has a stats row at the wrong angle.
  // -------------------------------------------------------------------------

  it('single-key: does NOT seed a MoonBoard stats row at an angle the climb is not graded at', async () => {
    await seedUser('u-moon-wrong', 'Mira');
    await seedClimb('moonboard', 'MOON-WRONG', null, 40);
    await seedStats('moonboard', 'MOON-WRONG', 40, { upstream: 6 });
    // Tick inserted directly, bypassing saveTick — this is a pre-migration prod
    // row, or anything else that writes boardsesh_ticks without the resolver.
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-WRONG',
      angle: 25,
      userId: 'u-moon-wrong',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'moonboard', 'MOON-WRONG', 25);

    expect(await statsRowCount('moonboard', 'MOON-WRONG', 25)).toBe(0);
    // And the graded angle is untouched by the refusal.
    const graded = await statsRow('moonboard', 'MOON-WRONG', 40);
    expect(Number(graded.total)).toBe(6);
  });

  it('bulk: does NOT seed a MoonBoard stats row at an angle the climb is not graded at', async () => {
    await seedUser('u-moon-wrong-bulk', 'Milo');
    await seedClimb('moonboard', 'MOON-WRONG-BULK', null, 40);
    await seedStats('moonboard', 'MOON-WRONG-BULK', 40, { upstream: 6 });
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-WRONG-BULK',
      angle: 25,
      userId: 'u-moon-wrong-bulk',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [{ boardType: 'moonboard', climbUuid: 'MOON-WRONG-BULK', angle: 25 }]);

    expect(await statsRowCount('moonboard', 'MOON-WRONG-BULK', 25)).toBe(0);
  });

  // The refusal must not extend to an angle the catalog actually grades. Note
  // the fixture has NO stats row anywhere, so the seed genuinely has to fire —
  // a fixture that already had a row would pass whatever the guard did, since
  // the seed is ON CONFLICT DO NOTHING.
  it('single-key: STILL seeds a MoonBoard row at the angle the climb IS graded at', async () => {
    await seedUser('u-moon-right', 'Moe');
    await seedClimb('moonboard', 'MOON-RIGHT', null, 40);
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-RIGHT',
      angle: 40,
      userId: 'u-moon-right',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'moonboard', 'MOON-RIGHT', 40);

    const seeded = await statsRow('moonboard', 'MOON-RIGHT', 40);
    expect(Number(seeded.bs)).toBe(1);
    expect(Number(seeded.total)).toBe(1);
  });

  // The post-#3851 shape: an angle-agnostic canonical climb (angle IS NULL)
  // seeds at whatever angle the climber ticked, exactly like Kilter/Tension.
  // This is what makes the guard remove itself once the re-import lands.
  it('single-key: STILL seeds when the MoonBoard climb row carries no angle (post-#3851)', async () => {
    await seedUser('u-moon-null', 'Nell');
    await seedClimb('moonboard', 'MOON-NULLANGLE', null, null);
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-NULLANGLE',
      angle: 25,
      userId: 'u-moon-null',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'moonboard', 'MOON-NULLANGLE', 25);

    const seeded = await statsRow('moonboard', 'MOON-NULLANGLE', 25);
    expect(Number(seeded.bs)).toBe(1);
  });

  // USER-CREATED climbs are outside the guard entirely, matching
  // resolveMoonBoardTickAngle and the moonboard_wrong_angle_stats_cleanup migration's `bc.user_id IS NULL` fence.
  // Nothing grades a climber's own problem per angle, so a tick at any angle is
  // legitimate and must seed a row. Deliberately NO stats row is pre-seeded at
  // 25: with one present, ON CONFLICT DO NOTHING makes the assertion pass
  // whether the guard fires or not. Deleting `bc.user_id IS NOT NULL` from the
  // seed guard turns this red.
  it('single-key: STILL seeds a user-created MoonBoard climb at an angle it is not set at', async () => {
    await seedUser('u-moon-owner', 'Ona');
    await seedClimb('moonboard', 'MOON-USER-SET', 'u-moon-owner', 40);
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-USER-SET',
      angle: 25,
      userId: 'u-moon-owner',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'moonboard', 'MOON-USER-SET', 25);

    const seeded = await statsRow('moonboard', 'MOON-USER-SET', 25);
    expect(Number(seeded.bs)).toBe(1);
  });

  // The bulk twin of the case above. The bulk seed carries the same predicate in
  // a different SHAPE (board_climbs lives inside an EXISTS rather than the outer
  // FROM), so a leg can go missing from one statement while the other keeps it —
  // which is exactly what happened to `bc.user_id IS NOT NULL` until QA caught
  // it. Every self-heal and backfill runs through this path, so the hole here is
  // wider than the single-key one. Same no-pre-seeded-row discipline: with a row
  // present, ON CONFLICT DO NOTHING would pass whatever the guard did.
  it('bulk: STILL seeds a user-created MoonBoard climb at an angle it is not set at', async () => {
    await seedUser('u-moon-owner-bulk', 'Obi');
    await seedClimb('moonboard', 'MOON-USER-SET-BULK', 'u-moon-owner-bulk', 40);
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-USER-SET-BULK',
      angle: 25,
      userId: 'u-moon-owner-bulk',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsBulk(db, [{ boardType: 'moonboard', climbUuid: 'MOON-USER-SET-BULK', angle: 25 }]);

    // Row count first, so dropping the fence reads as "expected 0 to be 1"
    // rather than as an undefined-property TypeError one line further down.
    expect(await statsRowCount('moonboard', 'MOON-USER-SET-BULK', 25)).toBe(1);
    const seeded = await statsRow('moonboard', 'MOON-USER-SET-BULK', 25);
    expect(Number(seeded.bs)).toBe(1);
  });

  // The post-#3849 shape: once the catalog grades BOTH angles, a per-angle tick
  // seeds normally again. Dropping the "carries real catalog data" leg for a
  // blunt `bc.angle = angle` equality turns this red.
  it('single-key: STILL seeds at a second angle that carries real catalog data', async () => {
    await seedUser('u-moon-both', 'Bex');
    await seedClimb('moonboard', 'MOON-BOTH-ANGLES', null, 40);
    await seedStats('moonboard', 'MOON-BOTH-ANGLES', 25, { upstream: 4 });
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-BOTH-ANGLES',
      angle: 25,
      userId: 'u-moon-both',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'moonboard', 'MOON-BOTH-ANGLES', 25);

    const row = await statsRow('moonboard', 'MOON-BOTH-ANGLES', 25);
    expect(Number(row.bs)).toBe(1);
    expect(Number(row.total)).toBe(5); // upstream 4 + 1 native
  });

  // Blast-radius fence, the mirror of the KEEP test above: a Kilter climb whose
  // catalog row happens to carry an angle must still seed at any ticked angle.
  it('single-key: a Kilter climb with an angle on its climb row still seeds at another angle', async () => {
    await seedUser('u-kilter-angled', 'Kit');
    await seedClimb('kilter', 'KILTER-ANGLED', null, 40);
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'KILTER-ANGLED',
      angle: 25,
      userId: 'u-kilter-angled',
      status: 'send',
      origin: 'native',
      climbedAt: '2026-01-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'kilter', 'KILTER-ANGLED', 25);

    const seeded = await statsRow('kilter', 'KILTER-ANGLED', 25);
    expect(Number(seeded.bs)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Grade provenance (#4798)
  //
  // The rule: the recompute writes difficulty_average / display_difficulty /
  // tick_graded_at when the climb is Boardsesh-owned OR the row's grade is ours
  // to write — no grade stored at all, or one we stamped that no upstream sync
  // has stamped over since. Everything else keeps the manufacturer's grade.
  // -------------------------------------------------------------------------

  it('single + bulk: a Woods catalog climb ticked at a NEW angle gets a grade there', async () => {
    await seedUser('u-woods', 'Wren');
    for (const uuid of ['WOODS-SINGLE', 'WOODS-BULK']) {
      // Woods imports catalog climbs with user_id NULL and exactly one graded
      // stats row, at the angle the wall is set to.
      await seedClimb('woods', uuid, null);
      await seedStats('woods', uuid, 25, {
        upstream: 0,
        displayDifficulty: 20,
        upstreamSyncedAt: '2026-01-01 00:00:00',
      });
      await seedTick({
        boardType: 'woods',
        climbUuid: uuid,
        angle: 40,
        userId: 'u-woods',
        status: 'send',
        origin: 'native',
        difficulty: 22,
        climbedAt: '2026-02-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, 'woods', 'WOODS-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'woods', climbUuid: 'WOODS-BULK', angle: 40 }]);

    for (const uuid of ['WOODS-SINGLE', 'WOODS-BULK']) {
      const ticked = await statsRow('woods', uuid, 40);
      expect(Number(ticked.display_difficulty)).toBe(22);
      expect(Number(ticked.difficulty)).toBe(22);
      expect(ticked.tick_graded_at).not.toBeNull();

      // The catalog's own graded angle is untouched, marker still NULL.
      const catalog = await statsRow('woods', uuid, 25);
      expect(Number(catalog.display_difficulty)).toBe(20);
      expect(catalog.tick_graded_at).toBeNull();
    }
  });

  it('a second climber’s grade at the new angle averages in (23 from 22 and 24)', async () => {
    await seedUser('u-woods-a', 'Wren');
    await seedUser('u-woods-b', 'Bo');
    await seedClimb('woods', 'WOODS-AVG', null);
    await seedStats('woods', 'WOODS-AVG', 25, {
      upstream: 0,
      displayDifficulty: 20,
      upstreamSyncedAt: '2026-01-01 00:00:00',
    });
    await seedTick({
      boardType: 'woods',
      climbUuid: 'WOODS-AVG',
      angle: 40,
      userId: 'u-woods-a',
      status: 'send',
      origin: 'native',
      difficulty: 22,
      climbedAt: '2026-02-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'woods', 'WOODS-AVG', 40);
    expect(Number((await statsRow('woods', 'WOODS-AVG', 40)).display_difficulty)).toBe(22);

    await seedTick({
      boardType: 'woods',
      climbUuid: 'WOODS-AVG',
      angle: 40,
      userId: 'u-woods-b',
      status: 'send',
      origin: 'native',
      difficulty: 24,
      climbedAt: '2026-02-02 00:00:00',
    });

    // Re-deriving our OWN grade is the second leg of the predicate: the row now
    // has a grade, but tick_graded_at is set and nothing upstream stamped it.
    await recomputeClimbStatsCore(db, 'woods', 'WOODS-AVG', 40);

    const row = await statsRow('woods', 'WOODS-AVG', 40);
    expect(Number(row.display_difficulty)).toBe(23);
    expect(Number(row.difficulty)).toBe(23);
  });

  it('single + bulk: a legacy graded row with no stamps keeps the upstream grade', async () => {
    await seedUser('u-legacy', 'Lex');
    for (const uuid of ['LEGACY-SINGLE', 'LEGACY-BULK']) {
      await seedClimb('tension', uuid, null);
      // 134k rows in prod look exactly like this: graded, non-owned, no
      // upstream_synced_at. "Unstamped" must NOT be read as "ours".
      await seedStats('tension', uuid, 40, {
        upstream: 3,
        displayDifficulty: 18,
        upstreamSyncedAt: null,
        tickGradedAt: null,
      });
      await seedTick({
        boardType: 'tension',
        climbUuid: uuid,
        angle: 40,
        userId: 'u-legacy',
        status: 'send',
        origin: 'native',
        difficulty: 25,
        climbedAt: '2026-02-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, 'tension', 'LEGACY-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'tension', climbUuid: 'LEGACY-BULK', angle: 40 }]);

    for (const uuid of ['LEGACY-SINGLE', 'LEGACY-BULK']) {
      const row = await statsRow('tension', uuid, 40);
      expect(Number(row.display_difficulty)).toBe(18);
      expect(Number(row.difficulty)).toBe(18);
      expect(row.tick_graded_at).toBeNull();
      // The count side still moved — only the grade is fenced off.
      expect(Number(row.bs)).toBe(1);
    }
  });

  // The regression the marker rule exists for. kilter-sync COALESCEs
  // display_difficulty but stamps upstream_synced_at on EVERY pass, so a pass
  // that shipped no grade leaves a row with our grade, our marker, and a stamp
  // newer than the marker. Under the old `tick_graded_at > upstream_synced_at`
  // rule that row was frozen: no later tick could refresh it and no delete could
  // clear it. Marker presence has to ignore the stamp entirely.
  it('single + bulk: a newer upstream stamp does NOT freeze a grade that still carries our marker', async () => {
    await seedUser('u-restamped', 'Rae');
    await seedUser('u-restamped-2', 'Rio');
    for (const uuid of ['RESTAMPED-SINGLE', 'RESTAMPED-BULK']) {
      await seedClimb('kilter', uuid, null);
      await seedStats('kilter', uuid, 40, {
        upstream: 2,
        displayDifficulty: 19,
        tickGradedAt: '2026-01-01 00:00:00',
        upstreamSyncedAt: '2026-02-01 00:00:00',
      });
      await seedTick({
        boardType: 'kilter',
        climbUuid: uuid,
        angle: 40,
        userId: 'u-restamped',
        status: 'send',
        origin: 'native',
        difficulty: 25,
        climbedAt: '2026-03-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, 'kilter', 'RESTAMPED-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: 'RESTAMPED-BULK', angle: 40 }]);

    for (const uuid of ['RESTAMPED-SINGLE', 'RESTAMPED-BULK']) {
      const row = await statsRow('kilter', uuid, 40);
      expect(Number(row.display_difficulty)).toBe(25);
      expect(Number(row.difficulty)).toBe(25);
      expect(row.tick_graded_at).not.toBeNull();
    }

    // A second climber's grade still moves it — the row is not stuck.
    for (const uuid of ['RESTAMPED-SINGLE', 'RESTAMPED-BULK']) {
      await seedTick({
        boardType: 'kilter',
        climbUuid: uuid,
        angle: 40,
        userId: 'u-restamped-2',
        status: 'send',
        origin: 'native',
        difficulty: 27,
        climbedAt: '2026-03-02 00:00:00',
      });
    }
    await recomputeClimbStatsCore(db, 'kilter', 'RESTAMPED-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: 'RESTAMPED-BULK', angle: 40 }]);
    for (const uuid of ['RESTAMPED-SINGLE', 'RESTAMPED-BULK']) {
      expect(Number((await statsRow('kilter', uuid, 40)).display_difficulty)).toBe(26);
    }

    // And deleting every graded tick still clears it, marker and all.
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE climb_uuid IN ('RESTAMPED-SINGLE', 'RESTAMPED-BULK')`);
    await recomputeClimbStatsCore(db, 'kilter', 'RESTAMPED-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: 'RESTAMPED-BULK', angle: 40 }]);
    for (const uuid of ['RESTAMPED-SINGLE', 'RESTAMPED-BULK']) {
      const row = await statsRow('kilter', uuid, 40);
      expect(row.display_difficulty).toBeNull();
      expect(row.tick_graded_at).toBeNull();
    }
  });

  it('single + bulk: a graded row with no marker is upstream’s, whatever the stamps say', async () => {
    await seedUser('u-upstream-graded', 'Ula');
    for (const uuid of ['UPSTREAM-GRADED-SINGLE', 'UPSTREAM-GRADED-BULK']) {
      await seedClimb('kilter', uuid, null);
      // Upstream supplied the grade, so it cleared the marker in the same
      // statement — the row reads "graded, not by us" no matter how the two
      // timestamps sit relative to each other.
      await seedStats('kilter', uuid, 40, {
        upstream: 2,
        displayDifficulty: 19,
        tickGradedAt: null,
        upstreamSyncedAt: '2026-02-01 00:00:00',
      });
      await seedTick({
        boardType: 'kilter',
        climbUuid: uuid,
        angle: 40,
        userId: 'u-upstream-graded',
        status: 'send',
        origin: 'native',
        difficulty: 25,
        climbedAt: '2026-03-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, 'kilter', 'UPSTREAM-GRADED-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'kilter', climbUuid: 'UPSTREAM-GRADED-BULK', angle: 40 }]);

    for (const uuid of ['UPSTREAM-GRADED-SINGLE', 'UPSTREAM-GRADED-BULK']) {
      const row = await statsRow('kilter', uuid, 40);
      expect(Number(row.display_difficulty)).toBe(19);
      expect(Number(row.difficulty)).toBe(19);
      expect(row.tick_graded_at).toBeNull();
      // The count side still moves — only the grade is fenced off.
      expect(Number(row.bs)).toBe(1);
    }
  });

  it('single + bulk: losing the last graded tick clears the tick-derived grade and its marker', async () => {
    await seedUser('u-clears', 'Cai');
    // DELETE removes the tick outright; DETACH is the upstream-deleted variant.
    // Both run through each path — the bulk clear arrives via LEFT JOIN sends
    // with no matching row, a different shape from the single-key `agg` CTE
    // (which always produces one row, with NULL aggregates).
    const clearCases = [
      { uuid: 'CLEAR-DELETE-SINGLE', bulk: false },
      { uuid: 'CLEAR-DETACH-SINGLE', bulk: false },
      { uuid: 'CLEAR-DELETE-BULK', bulk: true },
      { uuid: 'CLEAR-DETACH-BULK', bulk: true },
    ];

    for (const { uuid } of clearCases) {
      await seedClimb('woods', uuid, null);
      await seedTick({
        boardType: 'woods',
        climbUuid: uuid,
        angle: 40,
        userId: 'u-clears',
        status: 'send',
        origin: 'native',
        difficulty: 22,
        climbedAt: '2026-02-01 00:00:00',
      });
      await recomputeClimbStatsCore(db, 'woods', uuid, 40);
      const graded = await statsRow('woods', uuid, 40);
      expect(Number(graded.display_difficulty)).toBe(22);
      expect(graded.tick_graded_at).not.toBeNull();
    }

    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE climb_uuid IN ('CLEAR-DELETE-SINGLE', 'CLEAR-DELETE-BULK')`);
    await db.execute(sql`
      UPDATE boardsesh_ticks SET kilter_detached_at = now()
       WHERE climb_uuid IN ('CLEAR-DETACH-SINGLE', 'CLEAR-DETACH-BULK')
    `);

    for (const { uuid, bulk } of clearCases) {
      if (bulk) {
        await recomputeClimbStatsBulk(db, [{ boardType: 'woods', climbUuid: uuid, angle: 40 }]);
      } else {
        await recomputeClimbStatsCore(db, 'woods', uuid, 40);
      }
    }

    for (const { uuid } of clearCases) {
      const row = await statsRow('woods', uuid, 40);
      // Back to "ungraded", not "ours but blank" — a stale marker on a NULL
      // grade would read as a grade we own and nothing would ever refill it.
      expect(row.display_difficulty).toBeNull();
      expect(row.difficulty).toBeNull();
      expect(row.tick_graded_at).toBeNull();
    }
  });

  it('single + bulk: an ungraded MoonBoard CATALOG row is never tick-graded', async () => {
    await seedUser('u-moon', 'Mo');
    for (const uuid of ['MOON-CATALOG-SINGLE', 'MOON-CATALOG-BULK']) {
      // A real shape: the Moon catalog ships problems with no grade, and
      // moonboard-grade-repair.ts / repair-moonboard-8c-grades.ts fill them
      // later — but only while display_difficulty is still NULL.
      await seedClimb('moonboard', uuid, null, 40);
      await seedStats('moonboard', uuid, 40, { upstream: 6 });
      await seedTick({
        boardType: 'moonboard',
        climbUuid: uuid,
        angle: 40,
        userId: 'u-moon',
        status: 'send',
        origin: 'native',
        difficulty: 22,
        climbedAt: '2026-02-01 00:00:00',
      });
    }

    await recomputeClimbStatsCore(db, 'moonboard', 'MOON-CATALOG-SINGLE', 40);
    await recomputeClimbStatsBulk(db, [{ boardType: 'moonboard', climbUuid: 'MOON-CATALOG-BULK', angle: 40 }]);

    for (const uuid of ['MOON-CATALOG-SINGLE', 'MOON-CATALOG-BULK']) {
      const row = await statsRow('moonboard', uuid, 40);
      expect(row.display_difficulty).toBeNull();
      expect(row.difficulty).toBeNull();
      expect(row.tick_graded_at).toBeNull();
      // The count side still runs — only the grade is fenced.
      expect(Number(row.bs)).toBe(1);
    }
  });

  it('an OWNED MoonBoard climb still derives its grade from ticks', async () => {
    await seedUser('u-moon-owner', 'Moss');
    await seedClimb('moonboard', 'MOON-OWNED', 'u-moon-owner', 40);
    await seedStats('moonboard', 'MOON-OWNED', 40, {});
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'MOON-OWNED',
      angle: 40,
      userId: 'u-moon-owner',
      status: 'send',
      origin: 'native',
      difficulty: 22,
      climbedAt: '2026-02-01 00:00:00',
    });

    await recomputeClimbStatsCore(db, 'moonboard', 'MOON-OWNED', 40);

    // The fence is about the Moon CATALOG. Nothing repairs a climber's own
    // problem from the catalog, so ownership still wins.
    const row = await statsRow('moonboard', 'MOON-OWNED', 40);
    expect(Number(row.display_difficulty)).toBe(22);
    expect(Number(row.difficulty)).toBe(22);
    expect(row.tick_graded_at).not.toBeNull();
  });

  // The one-time repair for the rows already stranded before the code fix
  // shipped (#4798). Runs the real migration SQL against the four shapes it has
  // to tell apart, so a rewrite of the statement can't quietly widen its reach.
  it('the #4798 backfill migration grades stranded rows and leaves every other shape alone', async (testContext) => {
    if (BACKFILL_STATEMENTS.length === 0) {
      testContext.skip(
        'No packages/db/drizzle/*_backfill_tick_graded_climb_stats.sql yet — generate it with `vp exec drizzle-kit generate --custom` from packages/db/ and paste the backfill SQL (#4798).',
      );
      return;
    }

    await seedUser('u-backfill', 'Bex');

    // Pre-fix state: a stats row that exists only because a tick landed on it,
    // so it carries Boardsesh ascents and no grade at all.
    async function seedStrandedRow(boardType: string, uuid: string, ownerUserId: string | null) {
      await seedClimb(boardType, uuid, ownerUserId);
      await seedStats(boardType, uuid, 40, {});
      await db.execute(sql`
        UPDATE board_climb_stats
           SET boardsesh_ascensionist_count = 1, ascensionist_count = 1
         WHERE board_type = ${boardType} AND climb_uuid = ${uuid} AND angle = 40
      `);
    }

    // (a) stranded, non-owned, with a GRADED tick → repaired.
    await seedStrandedRow('woods', 'BACKFILL-GRADED', null);
    await seedTick({
      boardType: 'woods',
      climbUuid: 'BACKFILL-GRADED',
      angle: 40,
      userId: 'u-backfill',
      status: 'send',
      origin: 'native',
      difficulty: 21,
      climbedAt: '2026-02-01 00:00:00',
    });

    // (b) stranded, non-owned, but the tick carries no grade → nothing to
    // average, stays NULL.
    await seedStrandedRow('woods', 'BACKFILL-UNGRADED', null);
    await seedTick({
      boardType: 'woods',
      climbUuid: 'BACKFILL-UNGRADED',
      angle: 40,
      userId: 'u-backfill',
      status: 'send',
      origin: 'native',
      difficulty: null,
      climbedAt: '2026-02-01 00:00:00',
    });

    // (c) already graded by upstream → out of scope, grade and marker untouched.
    await seedClimb('kilter', 'BACKFILL-CATALOG', null);
    await seedStats('kilter', 'BACKFILL-CATALOG', 40, { upstream: 4, displayDifficulty: 18 });
    await db.execute(sql`
      UPDATE board_climb_stats
         SET boardsesh_ascensionist_count = 1, ascensionist_count = 5
       WHERE board_type = 'kilter' AND climb_uuid = 'BACKFILL-CATALOG' AND angle = 40
    `);
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'BACKFILL-CATALOG',
      angle: 40,
      userId: 'u-backfill',
      status: 'send',
      origin: 'native',
      difficulty: 25,
      climbedAt: '2026-02-01 00:00:00',
    });

    // (d) owned climb → the recompute already grades it every pass; the
    // backfill must not stamp tick_graded_at on rows it doesn't own the story of.
    await seedStrandedRow('kilter', 'BACKFILL-OWNED', 'u-backfill');
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'BACKFILL-OWNED',
      angle: 40,
      userId: 'u-backfill',
      status: 'send',
      origin: 'native',
      difficulty: 23,
      climbedAt: '2026-02-01 00:00:00',
    });

    // (e) no Boardsesh ascents on the row (boardsesh_ascensionist_count = 0):
    // the shape a key gets when its only graded send was IMPORTED — that
    // climber is already inside the upstream count. Deliberately out of scope;
    // it heals on the next native tick.
    await seedClimb('kilter', 'BACKFILL-NO-BS-ASCENTS', null);
    await seedStats('kilter', 'BACKFILL-NO-BS-ASCENTS', 40, { upstream: 3 });
    await seedTick({
      boardType: 'kilter',
      climbUuid: 'BACKFILL-NO-BS-ASCENTS',
      angle: 40,
      userId: 'u-backfill',
      status: 'send',
      origin: 'kilter_pull',
      difficulty: 24,
      climbedAt: '2026-02-01 00:00:00',
    });

    // (f) MoonBoard catalog row → fenced out; the Moon-catalog repair scripts
    // fill it, and they only act while display_difficulty is still NULL.
    await seedStrandedRow('moonboard', 'BACKFILL-MOONBOARD', null);
    await seedTick({
      boardType: 'moonboard',
      climbUuid: 'BACKFILL-MOONBOARD',
      angle: 40,
      userId: 'u-backfill',
      status: 'send',
      origin: 'native',
      difficulty: 20,
      climbedAt: '2026-02-01 00:00:00',
    });

    for (const statement of BACKFILL_STATEMENTS) {
      await db.execute(sql.raw(statement));
    }

    const repaired = await statsRow('woods', 'BACKFILL-GRADED', 40);
    expect(Number(repaired.display_difficulty)).toBe(21);
    expect(Number(repaired.difficulty)).toBe(21);
    expect(repaired.tick_graded_at).not.toBeNull();

    const ungraded = await statsRow('woods', 'BACKFILL-UNGRADED', 40);
    expect(ungraded.display_difficulty).toBeNull();
    expect(ungraded.tick_graded_at).toBeNull();

    const catalog = await statsRow('kilter', 'BACKFILL-CATALOG', 40);
    expect(Number(catalog.display_difficulty)).toBe(18);
    expect(catalog.tick_graded_at).toBeNull();

    const owned = await statsRow('kilter', 'BACKFILL-OWNED', 40);
    expect(owned.display_difficulty).toBeNull();
    expect(owned.tick_graded_at).toBeNull();

    const noBoardseshAscents = await statsRow('kilter', 'BACKFILL-NO-BS-ASCENTS', 40);
    expect(noBoardseshAscents.display_difficulty).toBeNull();
    expect(noBoardseshAscents.tick_graded_at).toBeNull();

    const moonboard = await statsRow('moonboard', 'BACKFILL-MOONBOARD', 40);
    expect(moonboard.display_difficulty).toBeNull();
    expect(moonboard.tick_graded_at).toBeNull();
  });
});
