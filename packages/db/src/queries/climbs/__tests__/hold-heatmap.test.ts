import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import type { DbInstance } from '../../../client/postgres';
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

void describe('getHoldHeatmapData query scoping', () => {
  void it('scopes community and personal aggregates to MoonBoard layout, angle, and selected sets', async () => {
    const whereFragments: SQL[] = [];
    const fakeDb = {
      select: () => queryChain(whereFragments),
    } as unknown as DbInstance;

    await getHoldHeatmapData(
      fakeDb,
      { board_name: 'moonboard', layout_id: 3, size_id: 1, set_ids: [5, 8], angle: 25 },
      {},
      'user-1',
    );

    assert.equal(whereFragments.length, 3);
    for (const fragment of whereFragments) {
      const rendered = sqlToString(fragment);
      assert.match(rendered, /layout_id/);
      assert.match(rendered, /angle/);
      assert.match(rendered, /required_set_ids/);
      assert.match(rendered, /moonboard/);
      assert.match(rendered, /25/);
    }
  });

  void it('keeps exact personal aggregates when progress filters are active', async () => {
    const whereFragments: SQL[] = [];
    const fakeDb = {
      select: () => queryChain(whereFragments),
    } as unknown as DbInstance;

    await getHoldHeatmapData(
      fakeDb,
      { board_name: 'moonboard', layout_id: 3, size_id: 1, set_ids: [5], angle: 40 },
      { showOnlyAttempted: true },
      'user-1',
    );

    // Community totals, the user's sends, and the user's summed attempt_count
    // remain separate queries. Distinct climbs must not stand in for attempts.
    assert.equal(whereFragments.length, 3);
  });
});
