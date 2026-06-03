import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Captured SQL fragments per call to tx.execute.
const executedSql: string[] = [];

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

function chainStub(): { insert: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> } {
  const chain: Record<string, unknown> = {};
  for (const method of ['values', 'onConflictDoNothing']) {
    chain[method] = vi.fn(() => chain);
  }
  return {
    insert: vi.fn(() => chain),
    execute: vi.fn(async (query: unknown) => {
      // Drizzle's sql template exposes `queryChunks` or `.toSQL()`. Use a
      // best-effort serialize that walks the object's string-like fields.
      const stringified = JSON.stringify(query);
      executedSql.push(stringified);
      return [];
    }),
  };
}

describe('recomputeClimbStats', () => {
  beforeEach(() => {
    executedSql.length = 0;
    vi.clearAllMocks();
  });

  it('seeds the stats row with explicit aurora=0 and boardsesh=0', async () => {
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
      auroraAscensionistCount: 0,
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
    // 2. ascensionist_count is Kilter's count plus Boardsesh's. Aurora and
    //    Kilter are the SAME upstream Kilter ascents pulled from two backends
    //    (legacy kilterboardapp.com vs Kilter Grips), so they must NOT be
    //    summed — we COALESCE to whichever backend reported (preferring the
    //    newer Kilter Grips column), default 0, then add Boardsesh's distinct
    //    senders. Each defaulted to 0 so the result never NULLs out.
    expect(sql).toContain('COALESCE(s.kilter_ascensionist_count, s.aurora_ascensionist_count, 0)');
    expect(sql).toContain('COALESCE(agg.distinct_senders, 0)');
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
    // so a single rated tick is enough to populate the column.
    expect(sql).toMatch(/AVG\(bt\.quality\)\s+AS avg_quality/);
    expect(sql).toMatch(/AVG\(bt\.difficulty\)\s+AS avg_difficulty/);

    // Each rating column must be guarded by the same boardsesh_owned CASE
    // expression used for FA, so Aurora's averages survive untouched on
    // Aurora-synced climbs.
    expect(sql).toMatch(/quality_average\s*=\s*CASE[\s\S]+?agg\.avg_quality[\s\S]+?s\.quality_average/);
    expect(sql).toMatch(/difficulty_average\s*=\s*CASE[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.difficulty_average/);
    expect(sql).toMatch(/display_difficulty\s*=\s*CASE[\s\S]+?agg\.avg_difficulty[\s\S]+?s\.display_difficulty/);
  });
});
