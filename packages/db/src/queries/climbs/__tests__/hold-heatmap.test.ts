import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import type { SerialPlanDb } from '../../util/serial-plan';
import { getHoldHeatmapData } from '../hold-heatmap';

function sqlToString<T>(fragment: SQL<T>): string {
  const chunks = (fragment as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) return sqlToString(chunk as SQL);
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const value = (chunk as { value: unknown }).value;
        return Array.isArray(value) ? value.join('') : String(value);
      }
      if (chunk && typeof chunk === 'object' && 'name' in chunk) return String((chunk as { name: unknown }).name);
      return typeof chunk === 'string' || typeof chunk === 'number' ? String(chunk) : '';
    })
    .join('');
}

function queryChain(whereFragments: SQL[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[method] = () => chain;
  }
  chain.where = (fragment: SQL) => {
    whereFragments.push(fragment);
    return chain;
  };
  // Drizzle query builders are awaitable; this mock mirrors that contract.
  // oxlint-disable-next-line unicorn/no-thenable
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return chain;
}

/**
 * A transaction-capable stand-in. `withSerialPlan` opens a transaction and runs
 * `SET LOCAL max_parallel_workers_per_gather = 0` before each SELECT, so the
 * double has to expose both `transaction` and `execute` — otherwise the guard
 * silently takes its fallback path and this test would pass on an unguarded
 * query. (The CI-gating guard assertions live in the backend suite; this package
 * runs on node's test runner.)
 */
function createFakeDb() {
  const whereFragments: SQL[] = [];
  const selections: Record<string, unknown>[] = [];
  const guards: SQL[] = [];
  const tx = {
    execute: (statement: SQL) => {
      guards.push(statement);
      return Promise.resolve([]);
    },
    select: (fields: Record<string, unknown>) => {
      selections.push(fields);
      return queryChain(whereFragments);
    },
  };
  const fakeDb = {
    transaction: (callback: (transactionDb: typeof tx) => unknown) => callback(tx),
  };
  return { db: fakeDb as unknown as SerialPlanDb, whereFragments, selections, guards };
}

void describe('getHoldHeatmapData query scoping', () => {
  void it('scopes community and personal aggregates to MoonBoard layout, angle, and selected sets', async () => {
    const { db, whereFragments, guards } = createFakeDb();

    await getHoldHeatmapData(
      db,
      { board_name: 'moonboard', layout_id: 3, size_id: 1, set_ids: [5, 8], angle: 25 },
      {},
      'user-1',
    );

    // Community aggregate + the two tick roll-ups, each behind its own guard.
    assert.equal(whereFragments.length, 3);
    assert.equal(guards.length, 3);
    for (const statement of guards) {
      assert.match(sqlToString(statement), /max_parallel_workers_per_gather/);
    }
    for (const fragment of whereFragments) {
      const rendered = sqlToString(fragment);
      assert.match(rendered, /layout_id/);
      assert.match(rendered, /angle/);
      assert.match(rendered, /required_set_ids/);
      assert.match(rendered, /moonboard/);
      assert.match(rendered, /25/);
    }
  });

  void it('collapses to the single personal aggregate when progress filters are active', async () => {
    const { db, whereFragments, selections, guards } = createFakeDb();

    await getHoldHeatmapData(
      db,
      { board_name: 'moonboard', layout_id: 3, size_id: 1, set_ids: [5], angle: 40 },
      { showOnlyAttempted: true },
      'user-1',
    );

    // The filters already narrow the climb set to the user's own climbs, so the
    // main aggregate IS the personal view — one query, no tick roll-ups. Matches
    // the web behaviour this function was extracted from.
    assert.equal(whereFragments.length, 1);
    assert.equal(guards.length, 1);
    assert.match(sqlToString(selections[0].totalAscents as SQL), /COUNT\(DISTINCT/);
  });

  void it('sums community ascents when no progress filter is active', async () => {
    const { db, selections } = createFakeDb();

    await getHoldHeatmapData(db, { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20], angle: 40 }, {});

    assert.match(sqlToString(selections[0].totalAscents as SQL), /SUM\(/);
  });
});
