import { describe, expect, it } from 'vite-plus/test';
import {
  getAllLayouts,
  getProductSize,
  getSetsForLayoutAndSize,
  getSizeEdges,
  getSizesForLayoutId,
  getTallWideScope,
} from '../product-sizes';
import { getSizeFullnessTiers, getSizeRank } from '../size-comparison';
import { QUANTUM_MODELS, QUANTUM_PRODUCT_ID, QUANTUM_SET_ID } from '../quantum';

const EXPECTED_MODELS = [
  ['xl', 'XL', 9101, 9201, 15, 15],
  ['l', 'L', 9102, 9202, 15, 12],
  ['m', 'M', 9103, 9203, 12, 12],
  ['s', 'S Fitness', 9104, 9204, 8, 12],
  ['belay', 'Belay Board', 9105, 9205, 8, 12],
] as const;

describe('Quantum model constants', () => {
  it('pins every model identity and grid dimension', () => {
    expect(
      Object.entries(QUANTUM_MODELS).map(([modelName, model]) => [
        modelName,
        model.displayName,
        model.layoutId,
        model.sizeId,
        model.columns,
        model.rows,
      ]),
    ).toEqual(EXPECTED_MODELS);
    expect(QUANTUM_PRODUCT_ID).toBe(91);
    expect(QUANTUM_SET_ID).toBe(1);
  });

  it.each(EXPECTED_MODELS)('%s resolves only its exact PSLS size', (_modelName, displayName, layoutId, sizeId) => {
    expect(getSizesForLayoutId('quantum', layoutId).map((size) => size.id)).toEqual([sizeId]);
    expect(getSetsForLayoutAndSize('quantum', layoutId, sizeId)).toEqual([{ id: 1, name: 'Default' }]);
    expect(getAllLayouts('quantum').find((layout) => layout.id === layoutId)).toEqual({
      id: layoutId,
      name: displayName,
      productId: QUANTUM_PRODUCT_ID,
    });

    for (const [, , otherLayoutId, otherSizeId] of EXPECTED_MODELS) {
      if (otherLayoutId === layoutId) continue;
      expect(getSetsForLayoutAndSize('quantum', layoutId, otherSizeId)).toEqual([]);
    }
  });

  it('keeps source-calibrated bounds explicitly unknown', () => {
    for (const [, , , sizeId] of EXPECTED_MODELS) {
      expect(getProductSize('quantum', sizeId)).toMatchObject({
        edgeLeft: null,
        edgeRight: null,
        edgeBottom: null,
        edgeTop: null,
      });
      expect(getSizeEdges('quantum', sizeId)).toBeNull();
      expect(getSizeRank('quantum', sizeId)).toBe(-1);
      expect(getSizeFullnessTiers('quantum', sizeId)).toEqual({
        shorterSizeIds: [],
        narrowerSameHeightSizeIds: [],
      });
    }
    expect(getTallWideScope('quantum', 9101, 9201)).toEqual({
      narrowerSizeIds: [],
      shorterSizeIds: [],
      hasNarrower: false,
      hasShorter: false,
    });
  });

  it('keeps existing Kilter and MoonBoard layout lookup behavior unchanged', () => {
    expect(getSizesForLayoutId('kilter', 1).map((size) => size.id)).toEqual([7, 8, 10, 14, 27, 28]);
    expect(getSizesForLayoutId('kilter', 8).map((size) => size.id)).toEqual([17, 18, 19, 21, 22, 23, 24, 25, 26, 29]);
    expect(getSizesForLayoutId('moonboard', 1)).toEqual([]);
  });
});
