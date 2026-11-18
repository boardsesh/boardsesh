import { describe, expect, it } from 'vitest';
import {
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

/**
 * Golden vectors: the native views are held to these. `BokehMotionTest.kt`
 * (and the Swift harness) pin the same numbers; change them together.
 */
const GOLDEN = {
  /** [side weight, key, arriving] → per-light weight. */
  weight: [
    [0.4, 0.5, false, 0.4],
    [0.7, 0.5, false, 0.7],
    [0.7, 0, false, 1],
    [0.7, 1, false, 0.4],
    [0.55, 0.3, true, 0.6184],
    [0.2, 0.6, true, 0.0512],
    [0.85, 0.9, false, 0.5422],
    [0.3, 0.9, false, 0.0948],
  ],
  /** [per-light weight, key, arriving, calm] → [glow, reach]. */
  shape: [
    [0.4, 0, false, false, 0.4, 0.79],
    [0.2, 0, true, false, 0.2, 1],
    [0.55, 0, true, false, 0.55, 1.05],
    [0.55, 0, true, true, 0.55, 1],
    [0.7, 0.4, false, false, 0.7, 0.895],
  ],
  /** [x over the pill width, ms] → the release's ceiling. */
  fill: [
    [1, 55, 0.5],
    [0, 55, 0],
    [0.5, 110, 0.5],
    [0.25, 150, 0.66752],
    [0.8, 40, 0.071567],
  ],
  /** ms → a fading light's share left. */
  fade: [
    [75, 0.5],
    [30, 0.896],
    [120, 0.104],
  ],
} as const;

describe('the frost swap timings', () => {
  it('matches the board: a 220 ms release with old lights out by 150 ms, at most 30 lights', () => {
    expect([BOKEH_SWAP_MS, BOKEH_SWAP_OUT_MS, MAX_GPU_BOKEH_LIGHTS]).toEqual([220, 150, 30]);
  });
});

describe('golden vectors', () => {
  it.each(GOLDEN.weight)('weight %s at key %s (arriving %s) is %s', (weight, key, arriving, expected) => {
    expect(frostLightWeight(weight, key, arriving, look)).toBeCloseTo(expected, 4);
  });

  it.each(GOLDEN.shape)(
    'shape of %s at key %s (arriving %s, calm %s) is %s, %s',
    (weight, key, arriving, calm, glow, reach) => {
      const shape = frostLightShape(weight, key, arriving, calm, look);
      expect(shape.glow).toBeCloseTo(glow, 4);
      expect(shape.reach).toBeCloseTo(reach, 4);
    },
  );

  it.each(GOLDEN.fill)('fills a light at x %s to %s by %s ms', (across, elapsedMs, expected) => {
    expect(frostReleaseFill(across, elapsedMs)).toBeCloseTo(expected, 4);
  });

  it.each(GOLDEN.fade)('leaves an old light at %s ms with %s', (elapsedMs, expected) => {
    expect(frostReleaseFade(elapsedMs)).toBeCloseTo(expected, 4);
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
  it('gives every light the same weight at the ends and at the floor, so a relabelled pair never jumps', () => {
    for (const weight of [0, 0.4, 1]) {
      const weights = [0, 0.3, 0.7, 1].map((key) => frostLightWeight(weight, key, false, look));
      for (const each of weights) expect(each).toBeCloseTo(weight, 5);
    }
  });

  it('keys a light from the edge its climb enters from', () => {
    expect(frostSweepKey(1, true)).toBe(0);
    expect(frostSweepKey(1, false)).toBe(1);
    expect(frostSweepKey(2, false)).toBe(1);
  });
});

describe('frostLightShape', () => {
  it('swells an arriving light by at most 5%, and never on a flick run', () => {
    const reaches = [0.5, 0.6, 0.7, 0.8, 0.9].map((weight) => frostLightShape(weight, 0, true, false, look).reach);
    expect(Math.max(...reaches)).toBeGreaterThan(1);
    expect(Math.max(...reaches)).toBeLessThanOrEqual(1.05 + 1e-6);
    expect(frostLightShape(0.7, 0, true, true, look).reach).toBe(1);
  });
});

describe('matching holds', () => {
  it('matches by hold id and colour, else within six points in the same colour', () => {
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00', id: 4 }, { x: 90, y: 0, color: '#ff0000', id: 4 })).toBe(true);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00', id: 4 }, { x: 0, y: 0, color: '#F00', id: 5 })).toBe(false);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00', id: 4 }, { x: 0, y: 0, color: '#0F0', id: 4 })).toBe(false);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00' }, { x: 5, y: 0, color: '#F00' })).toBe(true);
    expect(sameBokehHold({ x: 0, y: 0, color: '#F00' }, { x: 7, y: 0, color: '#F00' })).toBe(false);
    // Within 0.02 of a channel is the same colour, as the native views compare it.
    expect(sameBokehHold({ x: 0, y: 0, color: '#FF0000' }, { x: 0, y: 0, color: '#FC0000' })).toBe(true);
    expect(sameBokehHold({ x: 0, y: 0, color: '#FF0000' }, { x: 0, y: 0, color: '#F80000' })).toBe(false);
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
