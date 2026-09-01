import { describe, expect, it } from 'vitest';
import {
  MIN_REGISTRATION_SAMPLES,
  measurePairRegistration,
  projectRingUnits,
  rasterizeRing,
  ringAgreement,
  type AlphaPlane,
  type RegistrationSample,
} from './canonical-outlines';

/**
 * The canonical-projection helpers' own tests, against synthetic art — the same
 * split `segmentation/led-ring.ts` uses. They live in `scripts/` because the
 * package tsconfig's `rootDir: ./src` cannot reach this module.
 */

/** A soft-edged disc: alpha 255 inside, linear 2 px ramp at the rim. */
function discPlane(width: number, height: number, discs: Array<{ x: number; y: number; r: number }>): AlphaPlane {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = 0;
      for (const disc of discs) {
        const distance = Math.hypot(x - disc.x, y - disc.y);
        const value =
          distance <= disc.r ? 255 : distance >= disc.r + 2 ? 0 : Math.round(255 * (1 - (distance - disc.r) / 2));
        if (value > best) best = value;
      }
      data[y * width + x] = best;
    }
  }
  return { data, width, height };
}

function square(size: number, offsetX = 0, offsetY = 0): number[] {
  return [
    -size + offsetX,
    -size + offsetY,
    size + offsetX,
    -size + offsetY,
    size + offsetX,
    size + offsetY,
    -size + offsetX,
    size + offsetY,
  ];
}

describe('rasterizeRing', () => {
  it('fills a square with its own area', () => {
    const box = { left: -12, top: -12, width: 24, height: 24 };
    const filled = rasterizeRing(square(8), box);
    let area = 0;
    for (const value of filled) area += value;
    // A 16x16 square filled at pixel centres.
    expect(area).toBe(256);
  });
});

describe('ringAgreement', () => {
  it('is 1 for identical rings', () => {
    expect(ringAgreement(square(10), square(10))).toBe(1);
  });

  it('falls with displacement by the exact overlap ratio', () => {
    // 20x20 squares offset by 4: intersection 16x20, union 24x20 → 2/3.
    expect(ringAgreement(square(10), square(10, 4, 0))).toBeCloseTo(16 / 24, 2);
  });

  it('is 0 for disjoint rings and empty input', () => {
    expect(ringAgreement(square(2), square(2, 100, 100))).toBe(0);
    expect(ringAgreement([], [])).toBe(0);
  });
});

describe('projectRingUnits', () => {
  it('shifts by the offset divided by the radius, leaving values unrounded', () => {
    const projected = projectRingUnits([1, 2, -1, 0.5], { dx: 3, dy: -1.5 }, 30);
    expect(projected).toEqual([1.1, 1.95, -0.9, 0.45]);
  });
});

describe('measurePairRegistration', () => {
  /** Discs on a grid, canonical at 1x; the target draws them shifted. */
  function fixtures(shiftX: number, shiftY: number, scale: number) {
    const centres: Array<{ x: number; y: number }> = [];
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        centres.push({ x: 60 + column * 70, y: 60 + row * 70 });
      }
    }
    const canonical = discPlane(
      Math.round(340 * scale),
      Math.round(340 * scale),
      centres.map((centre) => ({ x: centre.x * scale, y: centre.y * scale, r: 14 * scale })),
    );
    const target = discPlane(
      340,
      340,
      centres.map((centre) => ({ x: centre.x + shiftX, y: centre.y + shiftY, r: 14 })),
    );
    const samples: RegistrationSample[] = centres.map((centre) => ({
      targetX: centre.x,
      targetY: centre.y,
      canonicalX: centre.x * scale,
      canonicalY: centre.y * scale,
      radiusPx: 16,
    }));
    return { canonical, target, samples };
  }

  it('recovers a pure shift to within a quarter pixel', () => {
    const { canonical, target, samples } = fixtures(3, -2, 1);
    const registration = measurePairRegistration(target, canonical, samples, 1);
    expect(registration).not.toBeNull();
    expect(Math.abs((registration?.dx ?? 0) - 3)).toBeLessThan(0.25);
    expect(Math.abs((registration?.dy ?? 0) + 2)).toBeLessThan(0.25);
    expect(registration?.iqrX ?? 99).toBeLessThan(0.5);
  });

  it('recovers a shift across a resolution change', () => {
    // Canonical rendered at 1.25x the target's scale — the Homewall family case.
    const { canonical, target, samples } = fixtures(2, 1, 1.25);
    const registration = measurePairRegistration(target, canonical, samples, 1.25);
    expect(registration).not.toBeNull();
    expect(Math.abs((registration?.dx ?? 0) - 2)).toBeLessThan(0.35);
    expect(Math.abs((registration?.dy ?? 0) - 1)).toBeLessThan(0.35);
  });

  it('shrugs off a minority of disagreeing windows via the median', () => {
    const { canonical, samples } = fixtures(0, 0, 1);
    // Target: most discs shifted by (2, 0), three of them somewhere else entirely.
    const centres = samples.map((sample, index) => ({
      x: sample.targetX + (index < 3 ? -4 : 2),
      y: sample.targetY + (index < 3 ? 3 : 0),
      r: 14,
    }));
    const target = discPlane(340, 340, centres);
    const registration = measurePairRegistration(target, canonical, samples, 1);
    expect(registration).not.toBeNull();
    expect(Math.abs((registration?.dx ?? 0) - 2)).toBeLessThan(0.35);
    expect(Math.abs(registration?.dy ?? 9)).toBeLessThan(0.35);
  });

  it('returns null when too few windows fit inside the images', () => {
    const { canonical, target, samples } = fixtures(1, 1, 1);
    const registration = measurePairRegistration(target, canonical, samples.slice(0, MIN_REGISTRATION_SAMPLES - 1), 1);
    expect(registration).toBeNull();
  });
});
