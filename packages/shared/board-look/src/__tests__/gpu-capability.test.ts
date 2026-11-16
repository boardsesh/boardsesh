import { describe, expect, it } from 'vitest';
import { supportsAuraGpu } from '../gpu-capability';

describe('native Aura capability', () => {
  it.each(['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill', 'moonboard', 'woods'])(
    'supports catalogue %s only on the new binary',
    (boardName) => {
      expect(supportsAuraGpu({ boardName, layoutId: 1, catalogueNative: true })).toBe(true);
      expect(supportsAuraGpu({ boardName, layoutId: 1, catalogueNative: false })).toBe(false);
    },
  );
  it('retains compatible Homewall frames on old binaries', () => {
    const board = { boardName: 'kilter', layoutId: 8, catalogueNative: false };
    expect(supportsAuraGpu({ ...board, frames: 'p4131r42' })).toBe(true);
    expect(supportsAuraGpu({ ...board, frames: 'p4131r12' })).toBe(false);
  });
  it('preserves catalogue aliases, auxiliary roles and the tallest output', () => {
    const board = { boardName: 'moonboard', layoutId: 7, catalogueNative: true };
    expect(
      supportsAuraGpu({ ...board, roleCodes: [42, 43, 44, 45, 46, 47, 48], frames: 'p1r46p2r48', height: 2304 }),
    ).toBe(true);
    expect(supportsAuraGpu({ ...board, roleCodes: [42], frames: 'p1r48' })).toBe(false);
    expect(supportsAuraGpu({ ...board, height: 2305 })).toBe(false);
  });
  it('defers custom walls and falls back for unsupported appearance and size', () => {
    const board = { boardName: 'tension', layoutId: 9, catalogueNative: true };
    expect(supportsAuraGpu({ ...board, boardName: 'spray' })).toBe(false);
    expect(supportsAuraGpu({ ...board, renderMode: 'classic' })).toBe(false);
    expect(supportsAuraGpu({ ...board, softDisc: true })).toBe(false);
    expect(supportsAuraGpu({ ...board, markStyle: 'glow-fill' })).toBe(false);
    expect(supportsAuraGpu({ ...board, markStyle: 'fill' })).toBe(false);
    expect(supportsAuraGpu({ ...board, markStyle: 'outline' })).toBe(true);
    expect(supportsAuraGpu({ ...board, width: 1537 })).toBe(false);
    expect(supportsAuraGpu({ ...board, holdCount: 1025 })).toBe(false);
  });
});
