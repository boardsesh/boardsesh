import { describe, it, expect, vi } from 'vitest';
import {
  MIN_SCALE,
  MAX_SCALE,
  ZOOM_THRESHOLD,
  clampTranslation,
  computeFocalPinchTranslation,
} from '@boardsesh/play-view';

// The hook module imports reanimated and RNGH at load time; neither runs under
// vitest's node env. clampPinchScale is a pure worklet, so empty stubs suffice.
vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-gesture-handler', () => ({ Gesture: {} }));

import { clampPinchScale } from '../use-zoom-pan-gesture';

describe('clampTranslation', () => {
  const containerWidth = 400;
  const containerHeight = 600;

  it('returns zero translation when scale is 1', () => {
    const result = clampTranslation(100, 200, 1, containerWidth, containerHeight);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('returns zero translation when scale is below 1', () => {
    const result = clampTranslation(50, 50, 0.5, containerWidth, containerHeight);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('allows translation within bounds at 2x zoom', () => {
    // At 2x on a 400px container, maxX = (400 * (2-1)) / 2 = 200
    // At 2x on a 600px container, maxY = (600 * (2-1)) / 2 = 300
    const result = clampTranslation(100, 150, 2, containerWidth, containerHeight);
    expect(result).toEqual({ x: 100, y: 150 });
  });

  it('clamps translation exceeding positive bounds', () => {
    const result = clampTranslation(500, 500, 2, containerWidth, containerHeight);
    expect(result.x).toBe(200);
    expect(result.y).toBe(300);
  });

  it('clamps translation exceeding negative bounds', () => {
    const result = clampTranslation(-500, -500, 2, containerWidth, containerHeight);
    expect(result.x).toBe(-200);
    expect(result.y).toBe(-300);
  });

  it('scales max bounds with zoom level', () => {
    // At 4x: maxX = (400 * 3) / 2 = 600, maxY = (600 * 3) / 2 = 900
    const result = clampTranslation(600, 900, 4, containerWidth, containerHeight);
    expect(result).toEqual({ x: 600, y: 900 });

    const overResult = clampTranslation(700, 1000, 4, containerWidth, containerHeight);
    expect(overResult).toEqual({ x: 600, y: 900 });
  });

  it('handles zero container dimensions', () => {
    const result = clampTranslation(10, 10, 2, 0, 0);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('handles negative translation symmetrically to positive', () => {
    const positive = clampTranslation(150, 250, 2, containerWidth, containerHeight);
    const negative = clampTranslation(-150, -250, 2, containerWidth, containerHeight);
    expect(positive.x).toBe(-negative.x);
    expect(positive.y).toBe(-negative.y);
  });
});

describe('zoom constants', () => {
  it('MIN_SCALE is 1', () => {
    expect(MIN_SCALE).toBe(1);
  });

  it('MAX_SCALE is 4', () => {
    expect(MAX_SCALE).toBe(4);
  });

  it('ZOOM_THRESHOLD is slightly above 1 for hysteresis', () => {
    expect(ZOOM_THRESHOLD).toBeGreaterThan(1);
    expect(ZOOM_THRESHOLD).toBeLessThan(1.1);
  });

  it('ZOOM_THRESHOLD is between MIN_SCALE and MAX_SCALE', () => {
    expect(ZOOM_THRESHOLD).toBeGreaterThan(MIN_SCALE);
    expect(ZOOM_THRESHOLD).toBeLessThan(MAX_SCALE);
  });
});

describe('clampPinchScale', () => {
  it('passes a scale inside the range through untouched', () => {
    expect(clampPinchScale(2.5, MIN_SCALE, MAX_SCALE)).toBe(2.5);
  });

  it('holds the default range at 4x', () => {
    expect(clampPinchScale(6, MIN_SCALE, MAX_SCALE)).toBe(4);
  });

  it('honours a raised max, so the spray editor can reach 8x', () => {
    expect(clampPinchScale(6, MIN_SCALE, 8)).toBe(6);
    expect(clampPinchScale(8, MIN_SCALE, 8)).toBe(8);
    expect(clampPinchScale(12, MIN_SCALE, 8)).toBe(8);
  });

  it('never lets a pinch-out go below the min', () => {
    expect(clampPinchScale(0.4, MIN_SCALE, 8)).toBe(MIN_SCALE);
    expect(clampPinchScale(0.4, MIN_SCALE, MAX_SCALE)).toBe(MIN_SCALE);
  });
});

describe('computeFocalPinchTranslation', () => {
  // First three tests cover the savedTranslate=0 case (initial pinch from
  // rest). They pass under both the correct formula and the historical
  // buggy `savedTranslate + focalOffset*(1-scaleDelta)` formula, since the
  // savedTranslate term vanishes either way.

  it('zooming at center produces no translation shift', () => {
    expect(computeFocalPinchTranslation({ focalOffset: 0, scaleDelta: 2, savedTranslate: 0 })).toBe(0);
  });

  it('zooming at offset shifts content toward center', () => {
    // Focal point 200 left of center, zooming to 2x: content should shift
    // 200px to the right to keep that point under the focal.
    expect(computeFocalPinchTranslation({ focalOffset: -200, scaleDelta: 2, savedTranslate: 0 })).toBe(200);
  });

  it('zooming at opposite offset shifts content opposite direction', () => {
    expect(computeFocalPinchTranslation({ focalOffset: 200, scaleDelta: 2, savedTranslate: 0 })).toBe(-200);
  });

  // These tests exercise the savedTranslate != 0 case — pinching while
  // already zoomed. They would fail under the buggy formula, which used
  // `savedTranslate + focalOffset*(1-scaleDelta)`.

  it('continuing a pinch with no scale change preserves the existing translation', () => {
    // scaleDelta = 1 means no scale change. Translation must stay put.
    expect(computeFocalPinchTranslation({ focalOffset: 50, scaleDelta: 1, savedTranslate: 30 })).toBe(30);
  });

  it('pinching at a focal point with existing translation applies scaleDelta to savedTranslate', () => {
    // Buggy formula gives: 30 + 50*(1-2) = -20
    // Correct formula gives: 50*(1-2) + 2*30 = -50 + 60 = 10
    expect(computeFocalPinchTranslation({ focalOffset: 50, scaleDelta: 2, savedTranslate: 30 })).toBe(10);
  });

  it('pinching in (scaleDelta < 1) from a translated state shrinks the translation', () => {
    // Going from 2x to 1x (scaleDelta = 0.5), with existing 100px translate.
    // Buggy formula: 100 + 0*(1-0.5) = 100 — keeps full translation
    // Correct formula: 0*(1-0.5) + 0.5*100 = 50 — translation halves with scale
    expect(computeFocalPinchTranslation({ focalOffset: 0, scaleDelta: 0.5, savedTranslate: 100 })).toBe(50);
  });
});
