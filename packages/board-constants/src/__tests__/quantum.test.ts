import { describe, expect, it } from 'vite-plus/test';
import {
  getAllLayouts,
  getProductSize,
  getSetsForLayoutAndSize,
  getSizeEdges,
  getSizesForLayoutId,
  getTallWideScope,
} from '../product-sizes';
import {
  QUANTUM_MODELS,
  QUANTUM_PRODUCT_IDS,
  QUANTUM_SET_ID,
  getQuantumBundledGeometry,
  getQuantumPlacementId,
} from '../quantum';
import { getBoardHolePlacements } from '../hole-placements';
import { getLedPlacements } from '../led-placements';

const MODELS = [
  ['xl', 'XL', 9101, 9201, 15, 15],
  ['l', 'L', 9101, 9202, 15, 12],
  ['m', 'M', 9101, 9203, 12, 12],
  ['s', 'S Fitness', 9104, 9204, 8, 12],
  ['belay', 'Belay Board', 9105, 9205, 8, 12],
] as const;

describe('fixed Quantum model constants', () => {
  it('shares standard topology while preserving each controller model', () => {
    expect(
      Object.entries(QUANTUM_MODELS).map(([key, model]) => [
        key,
        model.displayName,
        model.layoutId,
        model.sizeId,
        model.columns,
        model.rows,
      ]),
    ).toEqual(MODELS);
    expect(QUANTUM_PRODUCT_IDS).toEqual({ standard: 91, s: 94, belay: 95 });
    expect(QUANTUM_SET_ID).toBe(1);
    expect(getAllLayouts('quantum').map((layout) => layout.id)).toEqual([9101, 9104, 9105]);
    expect(getSizesForLayoutId('quantum', 9101).map((size) => size.id)).toEqual([9201, 9202, 9203]);
    expect(getSizesForLayoutId('quantum', 9104).map((size) => size.id)).toEqual([9204]);
    expect(getSizesForLayoutId('quantum', 9105).map((size) => size.id)).toEqual([9205]);
  });
  it.each(MODELS)('resolves %s through the ordinary geometry and size tables', (_key, _label, layoutId, sizeId) => {
    expect(getSetsForLayoutAndSize('quantum', layoutId, sizeId)).toEqual([{ id: 1, name: 'Default' }]);
    expect(getSizeEdges('quantum', sizeId)).not.toBeNull();
    const geometry = getQuantumBundledGeometry(layoutId, sizeId)!;
    const holeIds = new Set(getBoardHolePlacements('quantum')[`${layoutId}-1`]!.map(([id]) => id));
    const leds = getLedPlacements('quantum', layoutId, sizeId);
    expect(Object.keys(leds)).toHaveLength(geometry.placements.length);
    for (const placement of geometry.placements) {
      expect(holeIds.has(placement.placementId)).toBe(true);
      expect(leds[placement.placementId]).toBe(placement.ledPosition);
    }
  });
  it('keeps unrelated physical families outside standard size and crop comparisons', () => {
    expect(getProductSize('quantum', 9201)?.productId).toBe(91);
    expect(getProductSize('quantum', 9204)?.productId).toBe(94);
    expect(getProductSize('quantum', 9205)?.productId).toBe(95);
    expect(getTallWideScope('quantum', 9101, 9201)).toEqual({
      narrowerSizeIds: [9203],
      shorterSizeIds: [9202, 9203],
      hasNarrower: true,
      hasShorter: true,
    });
    expect(getSetsForLayoutAndSize('quantum', 9101, 9204)).toEqual([]);
    expect(getQuantumBundledGeometry(9104, 9201)).toBeNull();
    expect(getQuantumPlacementId(9101, 1001)).toBe(1_001_001);
    expect(getQuantumPlacementId(9104, 1001)).toBe(4_001_001);
  });
  it('preserves existing Kilter and MoonBoard catalogue lookup behavior', () => {
    expect(getSizesForLayoutId('kilter', 1).map((size) => size.id)).toEqual([7, 8, 10, 14, 27, 28]);
    expect(getSizesForLayoutId('moonboard', 1)).toEqual([]);
  });
});
