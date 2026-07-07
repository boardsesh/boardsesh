import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { recomputeClimbStatsBulk, type ClimbStatsKey } from '../recompute';

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

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<unknown> }).queryChunks ?? [];
  return chunks
    .filter((chunk): chunk is { value?: string[] } => typeof chunk === 'object' && chunk !== null)
    .flatMap((chunk) => chunk.value ?? [])
    .join('');
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
    assert.match(sqlText(db.queries[0]), /INSERT INTO board_climb_stats/);
    assert.match(sqlText(db.queries[1]), /UPDATE board_climb_stats/);
    // The counting rule + provenance guard must be present in the UPDATE.
    assert.match(sqlText(db.queries[1]), /bool_or\(bt\.origin <> 'native'\)/);
    assert.match(sqlText(db.queries[1]), /has_send AND NOT has_upstream/);
    // quality = 0 sentinel excluded; ascensionist = upstream + boardsesh.
    assert.match(sqlText(db.queries[1]), /AVG\(NULLIF\(bt\.quality, 0\)\)/);
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
