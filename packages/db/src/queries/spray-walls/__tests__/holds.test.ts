import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { recomputeMissingHoldCounts } from '../holds';
import { sqlText } from '../../../test-utils/sql-text';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

function makeDb() {
  const queries: string[] = [];
  const handle = {
    execute: (query: unknown) => {
      queries.push(sqlText(query));
      return Promise.resolve([]);
    },
  };
  return { queries, handle: handle as unknown as DrizzleDb };
}

/**
 * Shape-only coverage; the COUNTING behaviour (a removed hold shared by two
 * climbs leaves both on 1 and the untouched third on 0) is asserted against real
 * Postgres in recompute.integration.test.ts.
 */
void describe('recomputeMissingHoldCounts', () => {
  void it('counts only holds that have been removed, on this wall', async () => {
    const db = makeDb();
    await recomputeMissingHoldCounts(db.handle, 12);

    assert.equal(db.queries.length, 1, 'one statement rewrites the whole wall');
    const statement = db.queries[0];
    assert.match(statement, /UPDATE board_climbs/);
    assert.match(statement, /s\.removed_version_id IS NOT NULL/);
    // Scoped to the wall on BOTH sides of the join: the side table by wall_id —
    // hold ids are per wall, so without this every OTHER wall's removed holds
    // would be counted into this wall's climbs — and board_climb_holds by
    // board_type. Asserted as one string so dropping either clause fails here.
    assert.match(statement, /JOIN spray_wall_holds s ON s\.hold_id = h\.hold_id AND s\.wall_id = /);
    assert.match(statement, /h\.board_type = 'spray'/);
  });

  void it('rewrites only the spray partition of the wall it was given', async () => {
    const db = makeDb();
    await recomputeMissingHoldCounts(db.handle, 12);
    const statement = db.queries[0];
    assert.match(statement, /WHERE board_type = 'spray'/);
    assert.match(statement, /layout_id = \(SELECT layout_id FROM spray_walls WHERE id = /);
  });

  void it('stamps updated_at so the offline sync cursor ships the change', async () => {
    const db = makeDb();
    await recomputeMissingHoldCounts(db.handle, 12);
    assert.match(db.queries[0], /updated_at = now\(\)/);
  });

  void it('skips climbs whose count did not move, so a reset re-ships nothing extra', async () => {
    const db = makeDb();
    await recomputeMissingHoldCounts(db.handle, 12);
    assert.match(db.queries[0], /missing_hold_count IS DISTINCT FROM/);
  });

  void it('reports how many climbs changed', async () => {
    const handle = {
      execute: () => Promise.resolve([{ uuid: 'a' }, { uuid: 'b' }]),
    } as unknown as DrizzleDb;
    assert.equal(await recomputeMissingHoldCounts(handle, 1), 2);
  });
});
