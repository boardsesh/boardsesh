import { describe, expect, it } from 'vitest';
import { homographyFromAnchors, IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';
import { mapPhotoHoldToCanonical } from '../spray-hold-canonical';
import { mapCanonicalHoldsToPhoto } from '../spray-hold-geometry';

/** A wall photographed off-axis: the right edge is nearer the camera than the left. */
const SKEWED = homographyFromAnchors(
  [
    [40, 20],
    [960, 60],
    [980, 700],
    [20, 740],
  ],
  { width: 1000, height: 750 },
);

describe('mapPhotoHoldToCanonical', () => {
  it('is the identity when the canonical frame IS the photo frame', () => {
    const mapped = mapPhotoHoldToCanonical(IDENTITY_HOMOGRAPHY, { cx: 123, cy: 456, r: 22, outline: null });
    expect(mapped).toEqual({ cx: 123, cy: 456, r: 22, outline: null });
  });

  it('rounds to whole canonical pixels, because the columns are integers', () => {
    const mapped = mapPhotoHoldToCanonical([0.5, 0, 0, 0, 0.5, 0, 0, 0, 1], {
      cx: 101,
      cy: 205,
      r: 21,
      outline: null,
    });
    expect(mapped).toEqual({ cx: 51, cy: 103, r: 11, outline: null });
  });

  it('never rounds a hold down to a zero radius the server would refuse', () => {
    const mapped = mapPhotoHoldToCanonical([0.01, 0, 0, 0, 0.01, 0, 0, 0, 1], {
      cx: 100,
      cy: 100,
      r: 20,
      outline: null,
    });
    expect(mapped?.r).toBe(1);
  });

  it('answers null for a homography that sends the hold nowhere', () => {
    expect(mapPhotoHoldToCanonical([1, 0, 0, 0, 1, 0, 0, 0, 0], { cx: 5, cy: 5, r: 5, outline: null })).toBeNull();
  });

  it('answers null rather than a hold at a plausible-looking wrong coordinate', () => {
    expect(
      mapPhotoHoldToCanonical([Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1], { cx: 5, cy: 5, r: 5, outline: null }),
    ).toBeNull();
  });

  it('answers null for a hold past the column bounds, rather than failing the whole batch', () => {
    // Zod refuses the WHOLE upsert on one out-of-range hold, so a coordinate the
    // schema would reject has to be dropped client-side.
    expect(mapPhotoHoldToCanonical(IDENTITY_HOMOGRAPHY, { cx: 100_001, cy: 0, r: 10 })).toBeNull();
    expect(mapPhotoHoldToCanonical(IDENTITY_HOMOGRAPHY, { cx: 0, cy: -100_001, r: 10 })).toBeNull();
    expect(mapPhotoHoldToCanonical(IDENTITY_HOMOGRAPHY, { cx: 0, cy: 0, r: 10_001 })).toBeNull();
    // And takes the values exactly on the bound.
    expect(mapPhotoHoldToCanonical(IDENTITY_HOMOGRAPHY, { cx: 100_000, cy: -100_000, r: 10_000 })).toEqual({
      cx: 100_000,
      cy: -100_000,
      r: 10_000,
      outline: null,
    });
  });

  it('leaves the outline null for a hold that never had one', () => {
    expect(mapPhotoHoldToCanonical(SKEWED, { cx: 500, cy: 400, r: 20 })?.outline).toBeNull();
  });

  it('carries a silhouette across, still in radius units of the NEW radius', () => {
    const ring = [1, 0, 0, 1, -1, 0, 0, -1];
    const mapped = mapPhotoHoldToCanonical(SKEWED, { cx: 500, cy: 400, r: 20, outline: ring });
    expect(mapped?.outline).not.toBeNull();
    expect(mapped?.outline).toHaveLength(ring.length);
    for (const coordinate of mapped?.outline ?? []) {
      // Still roughly a unit ring: an off-axis photograph compresses one side,
      // it does not move the silhouette to the other end of the wall.
      expect(Math.abs(coordinate)).toBeLessThan(2);
    }
  });
});

describe('the read and write paths are inverses', () => {
  it('round-trips a hold centre and radius through a skewed wall', () => {
    const photoHold = { cx: 640, cy: 300, r: 24, outline: null };
    const canonical = mapPhotoHoldToCanonical(SKEWED, photoHold);
    expect(canonical).not.toBeNull();
    if (!canonical) return;

    const [back] = mapCanonicalHoldsToPhoto(SKEWED, [{ id: 1, ...canonical }]) ?? [];
    expect(back).toBeDefined();
    // Within a pixel each way: the write path rounds to whole canonical pixels,
    // and a projective map turns that rounding into a sub-pixel error here.
    expect(back.cx).toBeCloseTo(photoHold.cx, 0);
    expect(back.cy).toBeCloseTo(photoHold.cy, 0);
    expect(back.r).toBeCloseTo(photoHold.r, 0);
  });

  it('round-trips a silhouette through a skewed wall', () => {
    const ring = [1, 0, 0.7, 0.7, 0, 1, -0.7, 0.7, -1, 0, 0, -1];
    const canonical = mapPhotoHoldToCanonical(SKEWED, { cx: 300, cy: 500, r: 30, outline: ring });
    expect(canonical?.outline).not.toBeNull();
    if (!canonical) return;

    const [back] = mapCanonicalHoldsToPhoto(SKEWED, [{ id: 1, ...canonical }]) ?? [];
    expect(back?.outline).toBeDefined();
    for (let index = 0; index < ring.length; index += 1) {
      expect(back.outline?.[index]).toBeCloseTo(ring[index], 1);
    }
  });

  it('round-trips every hold on a 100-hold wall to within a pixel', () => {
    const photoHolds = Array.from({ length: 100 }, (_, index) => ({
      cx: 80 + (index % 10) * 90,
      cy: 80 + Math.floor(index / 10) * 60,
      r: 18 + (index % 5),
      outline: null,
    }));
    for (const photoHold of photoHolds) {
      const canonical = mapPhotoHoldToCanonical(SKEWED, photoHold);
      expect(canonical).not.toBeNull();
      if (!canonical) continue;
      const [back] = mapCanonicalHoldsToPhoto(SKEWED, [{ id: 1, ...canonical }]) ?? [];
      expect(Math.hypot(back.cx - photoHold.cx, back.cy - photoHold.cy)).toBeLessThan(1.5);
    }
  });
});
