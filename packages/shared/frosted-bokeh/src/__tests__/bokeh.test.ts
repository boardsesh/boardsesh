import { describe, expect, it } from 'vitest';
import {
  BOKEH_DARK_SURFACE,
  BOKEH_LIGHT_SURFACE,
  MAX_BOKEH_BLOBS,
  blobGradient,
  bokehPixel,
  buildBokehBlobs,
  type BokehPoint,
} from '../index';

const source = { w: 100, h: 120 };
const target = { w: 360, h: 44 };
const points: readonly BokehPoint[] = [
  { x: 20, y: 115, color: '#00DD00' },
  { x: 50, y: 60, color: '#4DF5FD' },
  { x: 80, y: 5, color: '#FF0000' },
];

describe('buildBokehBlobs', () => {
  it('preserves the native board button composition at scale one', () => {
    const blobs = buildBokehBlobs({ points, source, target, rotation: 'clockwise' });
    expect(blobs.map(({ x, y, r, color }) => ({ x, y, r, color }))).toEqual([
      { x: 15, y: 8.8, r: 46, color: '#00DD00' },
      { x: 180, y: 22, r: 46, color: '#4DF5FD' },
      { x: 345, y: 35.2, r: 46, color: '#FF0000' },
    ]);
    expect(blobs[0]?.peak).toBeCloseTo(0.95);
  });

  it('supports ordinary source coordinates independently of board rotation', () => {
    const blobs = buildBokehBlobs({
      points: [{ x: 25, y: 60, color: '#F00' }],
      source,
      target: { w: 200, h: 300 },
    });
    expect(blobs[0]).toMatchObject({ x: 50, y: 150, r: 46, color: '#F00' });
  });

  it('scales radii and blur with the canvas while preserving intensity', () => {
    const original = buildBokehBlobs({ points, source, target, rotation: 'clockwise' });
    const enlarged = buildBokehBlobs({
      points,
      source,
      target: { w: target.w * 4, h: target.h * 4 },
      rotation: 'clockwise',
      effectScale: 4,
    });
    for (const [index, blob] of enlarged.entries()) {
      const before = original[index];
      expect(blob.x).toBeCloseTo((before?.x ?? 0) * 4);
      expect(blob.y).toBeCloseTo((before?.y ?? 0) * 4);
      expect(blob.r).toBeCloseTo((before?.r ?? 0) * 4);
      expect(blob.peak).toBeCloseTo(before?.peak ?? 0);
    }
  });

  it('retains the spread of a long circuit within the drawing budget', () => {
    const circuit = Array.from({ length: 100 }, (_, index) => ({ x: index, y: 60, color: '#FFF' }));
    const blobs = buildBokehBlobs({ points: circuit, source, target });
    expect(blobs).toHaveLength(MAX_BOKEH_BLOBS);
    expect(blobs[0]?.x).toBe(0);
    expect(blobs.at(-1)?.x).toBeCloseTo(356.4);
  });

  it('clamps off-surface points and excludes non-finite coordinates', () => {
    const blobs = buildBokehBlobs({
      points: [
        { x: -10, y: 500, color: '#FFF' },
        { x: Number.NaN, y: 20, color: '#FFF' },
        { x: 30, y: Infinity, color: '#FFF' },
      ],
      source,
      target,
      rotation: 'clockwise',
    });
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatchObject({ x: 0, y: 0, r: 46 });
  });

  it.each([0, -1, Infinity, Number.NaN])('draws nothing for invalid dimensions or scale: %s', (invalid) => {
    expect(buildBokehBlobs({ points, source: { w: invalid, h: 120 }, target })).toEqual([]);
    expect(buildBokehBlobs({ points, source, target: { w: 360, h: invalid } })).toEqual([]);
    expect(buildBokehBlobs({ points, source, target, effectScale: invalid })).toEqual([]);
  });

  it('draws nothing without points', () => {
    expect(buildBokehBlobs({ points: [], source, target })).toEqual([]);
  });
});

describe('shared falloff and pixel sampling', () => {
  it('uses matching colour/opacity stops and reaches transparency at the edge', () => {
    const gradient = blobGradient({ color: '#F00', peak: 0.5 }, 0.6);
    expect(gradient).toContain('rgba(255, 0, 0, 0.3) 0%');
    expect(gradient).toContain('rgba(255, 0, 0, 0.24) 30%');
    expect(gradient).toContain('rgba(255, 0, 0, 0) 100%');
  });

  it('keeps a neutral surface when no blobs reach the pixel', () => {
    const blobs = buildBokehBlobs({ points, source, target, rotation: 'clockwise' });
    const outside = { x: 1000, y: 1000 };
    expect(bokehPixel(outside, blobs, { surface: BOKEH_DARK_SURFACE, blend: 'screen' })).toBe(
      bokehPixel(outside, [], { surface: BOKEH_DARK_SURFACE, blend: 'screen' }),
    );
  });

  it('fades back to the same base in dark, light and fallback blending', () => {
    const blobs = buildBokehBlobs({ points, source, target, rotation: 'clockwise' });
    const center = { x: 180, y: 22 };
    for (const blend of ['screen', 'multiply', 'normal'] as const) {
      for (const surface of [BOKEH_DARK_SURFACE, BOKEH_LIGHT_SURFACE]) {
        expect(bokehPixel(center, blobs, { surface, blend, fade: 1 })).toBe(bokehPixel(center, [], { surface, blend }));
      }
    }
  });
});
