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
  QUANTUM_RELEASED_MODELS,
  QUANTUM_SET_ID,
  getQuantumBundledGeometry,
  getQuantumPlacementId,
  getQuantumSourceDiodeBindings,
  isReleasedQuantumConfig,
  QUANTUM_MODEL_BY_EWALLS_TYPE,
  scaleQuantumGeometryCoordinate,
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
  it('accepts only released physical layout and size pairs', () => {
    expect(QUANTUM_RELEASED_MODELS).toEqual(['xl', 'l', 'm', 's']);
    for (const [model, , layoutId, sizeId] of MODELS) {
      expect(isReleasedQuantumConfig(layoutId, sizeId)).toBe(model !== 'belay');
    }
    expect(isReleasedQuantumConfig(9101, 9204)).toBe(false);
    expect(isReleasedQuantumConfig(9104, 9201)).toBe(false);
    expect(isReleasedQuantumConfig(9101, 0)).toBe(false);
  });

  it('binds the documented eWalls board types to the existing physical sizes', () => {
    expect(QUANTUM_MODEL_BY_EWALLS_TYPE).toEqual({ big: 'xl', medium: 'l', small: 'm', xsmall: 's', belay: 'belay' });
  });

  it.each(MODELS)(
    'pins every %s API diode UUID and wire address to a frozen physical placement',
    (_, __, layoutId, sizeId) => {
      const bindings = getQuantumSourceDiodeBindings(layoutId, sizeId)!;
      const geometry = getQuantumBundledGeometry(layoutId, sizeId)!;
      expect(bindings).toHaveLength(geometry.placements.length);
      expect(getQuantumSourceDiodeBindings(layoutId, sizeId)).toBe(bindings);
      for (const binding of bindings) {
        const placement = geometry.placements.find((candidate) => candidate.placementId === binding.placementId)!;
        expect(binding.diodeUuid).toMatch(/^[a-f0-9-]{36}$/);
        expect(binding.autocadId).toBe(placement.ledPosition);
        expect(Math.trunc(binding.x * 1000)).toBe(placement.x);
        expect(Math.trunc(binding.y * 1000)).toBe(placement.y);
        expect(Object.isFrozen(binding)).toBe(true);
      }
      expect(Object.isFrozen(bindings)).toBe(true);
      expect(Reflect.set(bindings[0]!, 'autocadId', -1)).toBe(false);
    },
  );

  it('shares upstream identity across standard sizes while keeping other families separate', () => {
    const xl = getQuantumSourceDiodeBindings(9101, 9201)!;
    const medium = getQuantumSourceDiodeBindings(9101, 9203)!;
    const shared = medium[0]!;
    expect(xl.find((diode) => diode.diodeUuid === shared.diodeUuid)).toBe(shared);
    expect(getQuantumSourceDiodeBindings(9104, 9201)).toBeNull();
  });

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
  it('rejects source placement ids that could overlap the next layout namespace', () => {
    expect(getQuantumPlacementId(9101, 999_999)).toBe(1_999_999);
    expect(() => getQuantumPlacementId(9101, 1_000_000)).toThrow(/999999/);
  });
  it('uses SQL-compatible coordinate truncation for positive and negative fractions', () => {
    expect(scaleQuantumGeometryCoordinate(1.2349)).toBe(1_234);
    expect(scaleQuantumGeometryCoordinate(-1.2349)).toBe(-1_234);
  });
  it('preserves existing Kilter and MoonBoard catalogue lookup behavior', () => {
    expect(getSizesForLayoutId('kilter', 1).map((size) => size.id)).toEqual([7, 8, 10, 14, 27, 28]);
    expect(getSizesForLayoutId('moonboard', 1)).toEqual([]);
  });
});
