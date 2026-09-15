import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { allocateHoldIds, allocateWallIds } from '../ids';
import { sqlText } from '../../../test-utils/sql-text';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Walk a drizzle `sql` chunk tree for the first numeric bound parameter. */
function firstNumericParam(query: unknown): number | undefined {
  if (typeof query === 'number') return query;
  if (query === null || typeof query !== 'object') return undefined;
  const node = query as { value?: unknown; queryChunks?: unknown[] };
  if (typeof node.value === 'number') return node.value;
  for (const chunk of node.queryChunks ?? []) {
    const found = firstNumericParam(chunk);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A fake handle that answers `SELECT nextval(...)` the way Postgres does — one
 * row per requested value, ids ascending, the driver's usual string-typed
 * bigint. No Postgres needed to prove the two things that matter here: that ONE
 * sequence value becomes both catalogue ids, and that a batch of hold ids comes
 * back unique and in order.
 */
function makeSequenceDb(start = 1) {
  const queries: string[] = [];
  let next = start;
  const handle = {
    execute: (query: unknown) => {
      const text = sqlText(query);
      queries.push(text);
      // `FROM generate_series(1, $n)` is the batch form; sqlText drops
      // parameters, so dig the count out of the chunk tree instead.
      const count = text.includes('generate_series') ? (firstNumericParam(query) ?? 0) : 1;
      return Promise.resolve(Array.from({ length: count }, () => ({ id: String(next++) })));
    },
  };
  return { queries, handle: handle as unknown as DrizzleDb };
}

void describe('allocateWallIds', () => {
  void it('uses ONE sequence value for both the layout id and the size id', async () => {
    const db = makeSequenceDb(7);
    const ids = await allocateWallIds(db.handle);

    assert.deepEqual(ids, { layoutId: 7, sizeId: 7 });
    assert.equal(db.queries.length, 1, 'a wall must cost exactly one nextval');
    assert.match(db.queries[0], /nextval\('spray_wall_catalog_id_seq'\)/);
  });

  void it('draws from the wall sequence, never the hold sequence', async () => {
    const db = makeSequenceDb();
    await allocateWallIds(db.handle);
    assert.doesNotMatch(db.queries[0], /spray_hold_catalog_id_seq/);
  });

  void it('throws rather than return NaN when the sequence answers nothing', async () => {
    const handle = { execute: () => Promise.resolve([]) } as unknown as DrizzleDb;
    await assert.rejects(() => allocateWallIds(handle), /spray_wall_catalog_id_seq returned no id/);
  });
});

void describe('allocateHoldIds', () => {
  void it('returns unique, strictly ascending ids for a batch', async () => {
    const db = makeSequenceDb(100);
    const ids = await allocateHoldIds(db.handle, 5);

    assert.deepEqual(ids, [100, 101, 102, 103, 104]);
    assert.equal(new Set(ids).size, ids.length, 'hold ids must be unique');
    for (let index = 1; index < ids.length; index += 1) {
      assert.ok(ids[index] > ids[index - 1], 'hold ids must be monotonic');
    }
  });

  void it('takes the whole batch in one round trip', async () => {
    const db = makeSequenceDb();
    await allocateHoldIds(db.handle, 400);
    assert.equal(db.queries.length, 1);
    assert.match(db.queries[0], /nextval\('spray_hold_catalog_id_seq'\)/);
    assert.match(db.queries[0], /generate_series/);
  });

  void it('is a no-op for a count of zero', async () => {
    const db = makeSequenceDb();
    assert.deepEqual(await allocateHoldIds(db.handle, 0), []);
    assert.equal(db.queries.length, 0);
  });

  void it('rejects a negative or fractional count', async () => {
    const db = makeSequenceDb();
    await assert.rejects(() => allocateHoldIds(db.handle, -1), /non-negative integer count/);
    await assert.rejects(() => allocateHoldIds(db.handle, 1.5), /non-negative integer count/);
  });
});
