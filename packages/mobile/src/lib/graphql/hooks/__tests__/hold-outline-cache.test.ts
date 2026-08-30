import { describe, expect, it } from 'vitest';
import { withHoldOutlineOverride, withoutHoldOutlineOverride } from '../hold-outline-cache';
import type { HoldOutlinesQueryResponse, HoldOutlineOverrideRow } from '../../operations';

// The outline editor's mutations write the React Query cache directly instead of
// invalidating — a refetch would re-download the config's whole traced shard set
// on every single save. That makes these two splices the only thing keeping the
// board on screen honest, so they get their own tests.

function overrideRow(overrides: Partial<HoldOutlineOverrideRow> = {}): HoldOutlineOverrideRow {
  return {
    placementId: 1448,
    kind: 'SILHOUETTE',
    outline: [1, 0, 0, 1, -1, 0],
    note: null,
    authorId: 'user-1',
    authorDisplayName: 'Marco',
    updatedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

function cache(overrides: HoldOutlineOverrideRow[]): HoldOutlinesQueryResponse {
  return {
    holdOutlines: {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 28,
      shardOutlines: [{ placementId: 1448, outline: [0.9, 0, 0, 0.9, -0.9, 0] }],
      overrides,
    },
  };
}

describe('withHoldOutlineOverride', () => {
  it('adds a row for a placement that had none', () => {
    const next = withHoldOutlineOverride(cache([]), overrideRow());
    expect(next.holdOutlines.overrides).toHaveLength(1);
    expect(next.holdOutlines.overrides[0].placementId).toBe(1448);
  });

  it('replaces the row for the same placement AND kind, rather than duplicating it', () => {
    const previous = cache([overrideRow({ outline: [2, 0, 0, 2, -2, 0] })]);
    const next = withHoldOutlineOverride(previous, overrideRow({ outline: [1, 0, 0, 1, -1, 0] }));
    expect(next.holdOutlines.overrides).toHaveLength(1);
    expect(next.holdOutlines.overrides[0].outline).toEqual([1, 0, 0, 1, -1, 0]);
  });

  it('leaves the other kind on the same placement standing', () => {
    // A silhouette correction and an LED-ring annotation describe different
    // boundaries of one hold and coexist; saving one must not drop the other.
    const previous = cache([overrideRow({ kind: 'LED_INNER' })]);
    const next = withHoldOutlineOverride(previous, overrideRow({ kind: 'SILHOUETTE' }));
    expect(next.holdOutlines.overrides.map((row) => row.kind).sort((a, b) => a.localeCompare(b))).toEqual([
      'LED_INNER',
      'SILHOUETTE',
    ]);
  });

  it('leaves other placements and the shard outlines untouched', () => {
    const previous = cache([overrideRow({ placementId: 4800 })]);
    const next = withHoldOutlineOverride(previous, overrideRow({ placementId: 1448 }));
    expect(next.holdOutlines.overrides.map((row) => row.placementId).sort((a, b) => a - b)).toEqual([1448, 4800]);
    expect(next.holdOutlines.shardOutlines).toEqual(previous.holdOutlines.shardOutlines);
  });
});

describe('withoutHoldOutlineOverride', () => {
  it('drops the named placement and kind', () => {
    const previous = cache([overrideRow()]);
    expect(withoutHoldOutlineOverride(previous, 1448, 'SILHOUETTE').holdOutlines.overrides).toEqual([]);
  });

  it('defaults an absent kind to SILHOUETTE, the way the resolver does', () => {
    // `kind` is optional on DeleteHoldOutlineOverrideInput. If the client didn't
    // normalise it the same way the server does, a bare revert would delete the
    // row on the backend and leave it on screen.
    const previous = cache([overrideRow()]);
    expect(withoutHoldOutlineOverride(previous, 1448, undefined).holdOutlines.overrides).toEqual([]);
  });

  it('does not touch the other kind on the same placement', () => {
    const previous = cache([overrideRow({ kind: 'SILHOUETTE' }), overrideRow({ kind: 'LED_INNER' })]);
    const next = withoutHoldOutlineOverride(previous, 1448, 'LED_INNER');
    expect(next.holdOutlines.overrides.map((row) => row.kind)).toEqual(['SILHOUETTE']);
  });

  it('is a no-op when nothing matches', () => {
    const previous = cache([overrideRow({ placementId: 4800 })]);
    expect(withoutHoldOutlineOverride(previous, 1448, 'SILHOUETTE').holdOutlines.overrides).toHaveLength(1);
  });
});
