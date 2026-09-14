// The nightly board-snapshot export publishes one SQLite file per
// `(board_type, layout_id)` to a PUBLIC bucket under guessable keys. A spray
// wall's partition is one climber's own wall, so `discoverLayoutPairs` must
// never hand it to the exporter — including when a run explicitly asks for it.
//
// The Postgres client is stubbed at the tagged-template boundary: the function
// under test is a query plus a filter, and the filter is the whole point.

import { describe, it, expect } from 'vite-plus/test';
import type { Sql } from 'postgres';
import { discoverLayoutPairs } from '../scripts/export-board-snapshots';

type DiscoveredRow = { board_type: string; layout_id: number };

/**
 * A stand-in for `postgres`'s tagged-template client. Every call — the two
 * predicate fragments and the SELECT itself — returns the same thenable row
 * list; the fragments are interpolated into a template the stub ignores. So the
 * stub cannot notice a regression in the SQL predicates — deliberately: the guard
 * under test is the TypeScript post-filter, which is the only spray exclusion.
 */
function sqlClientReturning(rows: readonly DiscoveredRow[]): Sql {
  const stub = () => Promise.resolve([...rows]);
  return stub as unknown as Sql;
}

const ROWS: DiscoveredRow[] = [
  { board_type: 'kilter', layout_id: 1 },
  { board_type: 'spray', layout_id: 900 },
  { board_type: 'spray', layout_id: 901 },
  { board_type: 'woods', layout_id: 1 },
];

describe('discoverLayoutPairs', () => {
  it('never publishes a spray wall', async () => {
    const pairs = await discoverLayoutPairs(sqlClientReturning(ROWS));
    expect(pairs).toEqual([
      { boardType: 'kilter', layoutId: 1 },
      { boardType: 'woods', layoutId: 1 },
    ]);
    expect(pairs.some((pair) => pair.boardType === 'spray')).toBe(false);
  });

  it('refuses spray even when a run asks for it by name', async () => {
    // `--board-type spray` narrows the SQL predicate, so a SQL-only exclusion
    // would have been bypassed by the very flag most likely to be typed.
    const sprayOnly = ROWS.filter((row) => row.board_type === 'spray');
    expect(await discoverLayoutPairs(sqlClientReturning(sprayOnly), { boardType: 'spray' })).toEqual([]);
  });

  it('still returns every other board type unchanged', async () => {
    const kilterOnly = ROWS.filter((row) => row.board_type === 'kilter');
    expect(await discoverLayoutPairs(sqlClientReturning(kilterOnly), { boardType: 'kilter' })).toEqual([
      { boardType: 'kilter', layoutId: 1 },
    ]);
  });
});
