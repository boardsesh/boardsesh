import { describe, expect, it } from 'vitest';
import { buildOccupiedPlacementIndexFromSnapshot, isLayerOverlapFilter, parseBoardLayerPlacementIds } from '..';

describe('layer overlap filtering', () => {
  it('parses only complete canonical frames', () => {
    expect(parseBoardLayerPlacementIds('p1000001r12p1000002r13p1000003r14')).toEqual([1_000_001, 1_000_002, 1_000_003]);
    expect(parseBoardLayerPlacementIds('junkp1r12')).toBeNull();
    expect(parseBoardLayerPlacementIds('p1r12junk')).toBeNull();
    expect(parseBoardLayerPlacementIds('p1r12p1r14')).toBeNull();
  });

  it('recognises exactly the three persisted overlap modes', () => {
    for (const persistedMode of ['off', 'none', 'at_most_one']) {
      expect(isLayerOverlapFilter(persistedMode)).toBe(true);
    }
    for (const unknownMode of ['atMostOne', 'On', '']) {
      expect(isLayerOverlapFilter(unknownMode)).toBe(false);
    }
  });

  it('builds occupied geometry from sanitized party layers', () => {
    expect(
      buildOccupiedPlacementIndexFromSnapshot({
        stale: false,
        layers: [
          { geometryKnown: true, placementIds: [1, 2] },
          { geometryKnown: true, placementIds: [2, 3] },
        ],
      }),
    ).toEqual({ geometryKnown: true, placementIds: new Set([1, 2, 3]) });
    expect(
      buildOccupiedPlacementIndexFromSnapshot({ stale: false, layers: [{ geometryKnown: false, placementIds: [] }] })
        .geometryKnown,
    ).toBe(false);
  });

  it('discards missing and stale snapshots instead of reusing their occupied holds', () => {
    const layers = [{ geometryKnown: true, placementIds: [1, 2] }];
    for (const snapshot of [null, undefined, { stale: true, layers }]) {
      expect(buildOccupiedPlacementIndexFromSnapshot(snapshot)).toEqual({
        geometryKnown: false,
        placementIds: new Set(),
      });
    }
    expect(buildOccupiedPlacementIndexFromSnapshot({ stale: false, layers })).toEqual({
      geometryKnown: true,
      placementIds: new Set([1, 2]),
    });
    expect(
      buildOccupiedPlacementIndexFromSnapshot({
        stale: false,
        layers: [...layers, { geometryKnown: false, placementIds: [] }],
      }),
    ).toEqual({ geometryKnown: false, placementIds: new Set() });
  });
});
