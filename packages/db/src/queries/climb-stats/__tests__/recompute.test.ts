import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { recomputeClimbStatsBulk, type ClimbStatsKey } from '../recompute';
import { sqlText } from '../../../test-utils/sql-text';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// Capture every db.execute(...) call so we can assert the chunking + dedup
// behaviour of recomputeClimbStatsBulk without a real Postgres. The SQL's
// counting correctness is covered end-to-end by the backend provenance-matrix
// integration test (recompute-climb-stats.test.ts).
function makeDb() {
  const queries: unknown[] = [];
  const handle = {
    execute: (query: unknown) => {
      queries.push(query);
      return Promise.resolve([]);
    },
  };
  return { queries, handle: handle as unknown as DrizzleDb };
}

void describe('recomputeClimbStatsBulk', () => {
  void it('is a no-op (no queries) when given no keys', async () => {
    const db = makeDb();
    await recomputeClimbStatsBulk(db.handle, []);
    assert.equal(db.queries.length, 0);
  });

  void it('emits one seed INSERT + one aggregate UPDATE for a single chunk', async () => {
    const db = makeDb();
    await recomputeClimbStatsBulk(db.handle, [{ boardType: 'kilter', climbUuid: 'A', angle: 40 }]);

    assert.equal(db.queries.length, 2);
    const seedSql = sqlText(db.queries[0]);
    assert.match(seedSql, /INSERT INTO board_climb_stats/);
    // Smoke test only — the guard's BEHAVIOUR (phantom key seeds nothing; the
    // real key beside it in the same chunk is untouched; a real climb ticked at
    // a new angle still seeds) is asserted against real Postgres in
    // packages/backend/src/__tests__/recompute-climb-stats.test.ts, because
    // this package has no vitest project and CI never runs its tsx --test suite.
    assert.match(seedSql, /WHERE EXISTS \(\s*SELECT 1\s*FROM board_climbs bc/);
    assert.match(seedSql, /bc\.uuid = k\.climb_uuid/);
    assert.match(seedSql, /bc\.board_type = k\.board_type/);
    // Seeded rows are on the 1-5 scale from birth (#3529, seed half).
    assert.match(seedSql, /quality_normalized/);
    const updateSql = sqlText(db.queries[1]);
    assert.match(updateSql, /UPDATE board_climb_stats/);
    // The counting rule + provenance guard must be present in the UPDATE. The
    // upstream-represented flag is scoped to imported FLASH/SEND ticks (an
    // imported bid must not disqualify a native send — upstream ascent counts
    // have no bids), and the native side is the absorption-aware flag (a
    // pushed-back tick the upstream snapshot has plausibly re-counted stops
    // contributing).
    assert.match(updateSql, /bool_or\(bt\.origin <> 'native' AND bt\.status IN \('flash','send'\)\)/);
    assert.match(updateSql, /has_unabsorbed_native_send AND NOT has_upstream/);
    // Owned-climb quality: quality = 0 sentinel excluded; ascensionist = upstream + boardsesh.
    assert.match(updateSql, /AVG\(NULLIF\(bt\.quality, 0\)\)/);
    // Kilter-detached (upstream-deleted) rows must be excluded from the count.
    assert.match(updateSql, /kilter_detached_at IS NULL/);
    // Quality blend — the Boardsesh side (one vote per climber = LATEST rated
    // native flash/send tick) and the blended non-owned quality_average. Owned
    // climbs NULL the blend-input columns (they never blend), matching the
    // backfill migration so the columns mean the same thing everywhere.
    assert.match(
      updateSql,
      /boardsesh_quality_sum\s*=\s*CASE WHEN owned\.boardsesh_owned THEN NULL ELSE bq\.bs_quality_sum END/,
    );
    assert.match(
      updateSql,
      /boardsesh_quality_count\s*=\s*CASE WHEN owned\.boardsesh_owned THEN NULL ELSE NULLIF\(bq\.bs_quality_count, 0\) END/,
    );
    // The vote query: native-only, rated, one row per user (latest wins).
    assert.match(updateSql, /DISTINCT ON \(bt\.board_type, bt\.climb_uuid, bt\.angle, bt\.user_id\)/);
    assert.match(updateSql, /bt\.origin = 'native'/);
    assert.match(updateSql, /bt\.quality >= 1/);
    assert.match(updateSql, /ORDER BY[\s\S]*bt\.climbed_at DESC, bt\.id DESC/);
    // Non-owned quality_average is the blend (division by the summed weights),
    // NOT the plain upstream value.
    assert.match(updateSql, /COALESCE\(s\.upstream_quality_average \* s\.upstream_ascensionist_count, 0\)/);
    assert.match(
      updateSql,
      /CASE WHEN s\.upstream_quality_average IS NOT NULL THEN s\.upstream_ascensionist_count END/,
    );
  });

  void it('dedupes identical keys into a single chunk', async () => {
    const db = makeDb();
    // 600 copies of ONE key: without dedup that would be 2 chunks (4 queries);
    // deduped to 1 distinct key it must be a single chunk (2 queries).
    const dupes: ClimbStatsKey[] = Array.from({ length: 600 }, () => ({
      boardType: 'kilter',
      climbUuid: 'A',
      angle: 40,
    }));
    await recomputeClimbStatsBulk(db.handle, dupes);
    assert.equal(db.queries.length, 2);
  });

  void it('treats same climb at different angles as distinct keys', async () => {
    const db = makeDb();
    await recomputeClimbStatsBulk(db.handle, [
      { boardType: 'kilter', climbUuid: 'A', angle: 40 },
      { boardType: 'kilter', climbUuid: 'A', angle: 50 },
    ]);
    // 2 distinct keys still fit one chunk → seed + update.
    assert.equal(db.queries.length, 2);
  });

  void it('chunks distinct keys into batches of 500', async () => {
    const db = makeDb();
    const keys: ClimbStatsKey[] = Array.from({ length: 501 }, (_, i) => ({
      boardType: 'kilter',
      climbUuid: `C${i}`,
      angle: 40,
    }));
    await recomputeClimbStatsBulk(db.handle, keys);

    // 501 distinct keys → 2 chunks (500 + 1) → 2 queries each = 4 total.
    assert.equal(db.queries.length, 4);
  });
});
