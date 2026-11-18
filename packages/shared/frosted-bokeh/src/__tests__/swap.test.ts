import { describe, expect, it } from 'vitest';
import {
  BOKEH_DISSOLVE_MS,
  BOKEH_SWAP_MS,
  BOKEH_SWAP_OUT_MS,
  MAX_GPU_BOKEH_LIGHTS,
  bokehSeed,
  buildBokehBlobs,
  capBokehLights,
  frostLightShape,
  frostLightWeight,
  frostReleaseFade,
  frostReleaseFill,
  frostSweepKey,
  parseFrostSwapLook,
  sameBokehHold,
} from '../index';

/** The player's look as `encodeSwapLook(PLAYER_SWAP_LOOK)` sends it. */
const PLAYER_LOOK = [2, 0.25, 0.25, 0.4, 0.4, 0, 0, 0.4, 0.15, 0.05, 0.25, 0, 2, 0.35, 0];
const look = parseFrostSwapLook(PLAYER_LOOK)!;

describe('the frost swap timings', () => {
  it('matches the board: a 220 ms release, old lights out by 150 ms, a 240 ms Reduce Motion dissolve', () => {
    expect([BOKEH_SWAP_MS, BOKEH_SWAP_OUT_MS, BOKEH_DISSOLVE_MS]).toEqual([220, 150, 240]);
    expect(MAX_GPU_BOKEH_LIGHTS).toBe(30);
  });
});

describe('parseFrostSwapLook', () => {
  it('reads the board look with the board clamps', () => {
    expect(look).toMatchObject({ holdWindow: 0.25, lowWindow: 0.25, floor: 0.4, ghost: 0.4, tighten: 0.35 });
    expect(parseFrostSwapLook([1, 0.25])).toBeNull();
    expect(parseFrostSwapLook(PLAYER_LOOK.map((value, index) => (index === 3 ? Number.NaN : value)))).toBeNull();
    // A swell needs its tail: the window shrinks to leave it room.
    const swollen = parseFrostSwapLook(PLAYER_LOOK.map((value, index) => (index === 1 ? 1 : value)))!;
    expect(swollen.holdWindow).toBe(0.75);
  });
});

describe('frostLightWeight', () => {
  // The same numbers BokehMotionTest.kt and the Swift harness pin.
  it('dims each light over its own quarter of the side, the far edge first', () => {
    expect(frostLightWeight(0.4, 0.5, false, look)).toBeCloseTo(0.4, 4);
    expect(frostLightWeight(0.7, 0.5, false, look)).toBeCloseTo(0.7, 4);
    expect(frostLightWeight(0.7, 0, false, look)).toBeCloseTo(1, 4);
    expect(frostLightWeight(0.7, 1, false, look)).toBeCloseTo(0.4, 4);
  });

  it('gives every light the same weight at the ends and at the floor, so a relabelled pair never jumps', () => {
    for (const weight of [0, 0.4, 1]) {
      const weights = [0, 0.3, 0.7, 1].map((key) => frostLightWeight(weight, key, false, look));
      for (const each of weights) expect(each).toBeCloseTo(weight, 5);
    }
  });
});

describe('frostLightShape', () => {
  it('pulls a leaving light in to a 0.79 standby at the floor', () => {
    expect(frostLightShape(0.4, 0, false, false, look)).toEqual({ glow: 0.4, reach: expect.closeTo(0.79, 5) });
  });

  it('shows an arriving light as a ghost up to 40% below the floor, then fills it', () => {
    expect(frostLightShape(0.2, 0, true, false, look).glow).toBeCloseTo(0.2, 5);
    expect(frostLightShape(0.4, 0, true, false, look).glow).toBeCloseTo(0.4, 5);
    expect(frostLightShape(0.7, 0, true, false, look).glow).toBeCloseTo(0.7, 5);
    expect(frostLightShape(1, 0, true, false, look)).toEqual({ glow: 1, reach: 1 });
  });

  it('swells an arriving light by at most 5%, and never on a flick run', () => {
    const reaches = [0.5, 0.6, 0.7, 0.8, 0.9].map((weight) => frostLightShape(weight, 0, true, false, look).reach);
    expect(Math.max(...reaches)).toBeGreaterThan(1);
    expect(Math.max(...reaches)).toBeLessThanOrEqual(1.05 + 1e-6);
    expect(frostLightShape(0.7, 0, true, true, look).reach).toBe(1);
  });
});

describe('the standalone release', () => {
  it('fills from the right edge: each light over half the release, in sweep order', () => {
    expect(frostSweepKey(1, true)).toBe(0);
    expect(frostReleaseFill(1, 55, false)).toBeCloseTo(0.5, 5);
    expect(frostReleaseFill(0, 55, false)).toBe(0);
    expect(frostReleaseFill(0, 165, false)).toBeCloseTo(0.5, 5);
    expect(frostReleaseFill(0, 220, false)).toBe(1);
  });

  it('takes the old lights out by 150 ms on a smoothstep', () => {
    expect(frostReleaseFade(75, false)).toBeCloseTo(0.5, 5);
    expect(frostReleaseFade(150, false)).toBe(0);
  });

  it('dissolves linearly over 240 ms with no stagger under Reduce Motion', () => {
    expect(frostReleaseFill(0, 120, true)).toBeCloseTo(0.5, 5);
    expect(frostReleaseFill(1, 120, true)).toBeCloseTo(0.5, 5);
    expect(frostReleaseFade(120, true)).toBeCloseTo(0.5, 5);
  });
});

describe('matching holds', () => {
  it('matches by hold id and colour, else within six points in the same colour', () => {
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00', id: 4 }, { x: 90, y: 0, color: '#f00', id: 4 })).toBe(true);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00', id: 4 }, { x: 0, y: 0, color: '#F00', id: 5 })).toBe(false);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00', id: 4 }, { x: 0, y: 0, color: '#0F0', id: 4 })).toBe(false);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00' }, { x: 5, y: 0, color: '#F00' })).toBe(true);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00' }, { x: 7, y: 0, color: '#F00' })).toBe(false);
  });

  it('carries the hold id through the blob geometry', () => {
    const blobs = buildBokehBlobs({
      points: [
        { x: 10, y: 10, color: '#F00', id: 42 },
        { x: 50, y: 50, color: '#0F0' },
      ],
      source: { w: 100, h: 100 },
      target: { w: 300, h: 44 },
      rotation: 'clockwise',
    });
    expect(blobs.map((blob) => blob.id)).toEqual([42, undefined]);
  });
});

describe('bokehSeed', () => {
  it('follows the hold id wherever the light sits, in 0..<2π', () => {
    expect(bokehSeed({ x: 10, y: 20, id: 7 })).toBe(bokehSeed({ x: 200, y: 4, id: 7 }));
    expect(bokehSeed({ x: 10, y: 20, id: 7 })).not.toBe(bokehSeed({ x: 10, y: 20, id: 8 }));
    for (const seed of [bokehSeed({ x: 10, y: 20, id: 7 }), bokehSeed({ x: 33.5, y: 12 })]) {
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(Math.PI * 2);
    }
  });

  it('falls back to a hash of the position', () => {
    expect(bokehSeed({ x: 33.5, y: 12 })).toBe(bokehSeed({ x: 33.5, y: 12 }));
    expect(bokehSeed({ x: 33.5, y: 12 })).not.toBe(bokehSeed({ x: 34.5, y: 12 }));
  });
});

describe('capBokehLights', () => {
  it('keeps the strongest thirty in drawing order', () => {
    const lights = Array.from({ length: 40 }, (_, index) => ({ x: index, peak: index / 40 }));
    const capped = capBokehLights(lights);
    expect(capped).toHaveLength(30);
    expect(capped.map((light) => light.x)).toEqual(Array.from({ length: 30 }, (_, index) => index + 10));
  });
});
