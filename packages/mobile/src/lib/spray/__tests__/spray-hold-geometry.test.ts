import { describe, it, expect } from 'vitest';
import { homographyFromAnchors, IDENTITY_HOMOGRAPHY, mapPoint } from '@boardsesh/spray-wall-geometry';
import { mapCanonicalHoldsToPhoto } from '../spray-hold-geometry';

/**
 * A photo whose wall corners are an off-axis trapezoid, mapped onto a
 * 1000x800 canonical frame. The forward matrix is photo->canonical, which is
 * what a version stores; the render path uses its inverse.
 */
const PHOTO_ANCHORS: [number, number][] = [
  [100, 120],
  [900, 80],
  [960, 700],
  [40, 660],
];
const FRAME = { width: 1000, height: 800 };
const PHOTO_TO_CANONICAL = homographyFromAnchors(PHOTO_ANCHORS, FRAME);

describe('mapCanonicalHoldsToPhoto', () => {
  it('leaves holds where they are under the identity matrix', () => {
    const mapped = mapCanonicalHoldsToPhoto(IDENTITY_HOMOGRAPHY, [{ id: 1, cx: 300, cy: 400, r: 20 }]);
    expect(mapped).toEqual([{ id: 1, cx: 300, cy: 400, r: 20 }]);
  });

  it('puts a canonical corner back on the photo corner it came from', () => {
    // Canonical (0, 0) is the top-left anchor by construction, so the inverse has
    // to land the hold on the pixel the owner tapped.
    const mapped = mapCanonicalHoldsToPhoto(PHOTO_TO_CANONICAL, [{ id: 1, cx: 0, cy: 0, r: 10 }]);
    expect(mapped).not.toBeNull();
    expect(mapped![0].cx).toBeCloseTo(PHOTO_ANCHORS[0][0], 6);
    expect(mapped![0].cy).toBeCloseTo(PHOTO_ANCHORS[0][1], 6);
  });

  it('round-trips a hold through the stored matrix', () => {
    const mapped = mapCanonicalHoldsToPhoto(PHOTO_TO_CANONICAL, [{ id: 1, cx: 640, cy: 210, r: 18 }]);
    const [backX, backY] = mapPoint(PHOTO_TO_CANONICAL, mapped![0].cx, mapped![0].cy);
    expect(backX).toBeCloseTo(640, 5);
    expect(backY).toBeCloseTo(210, 5);
  });

  it('scales the radius with the local map, not by a constant', () => {
    // The photo's far edge is compressed relative to its near edge, so the same
    // canonical radius must come out smaller there. A constant scale would make
    // both equal and is the bug `mapRadius` exists to prevent.
    const mapped = mapCanonicalHoldsToPhoto(PHOTO_TO_CANONICAL, [
      { id: 1, cx: 60, cy: 400, r: 20 },
      { id: 2, cx: 940, cy: 400, r: 20 },
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped![0].r).not.toBeCloseTo(mapped![1].r, 3);
  });

  it('maps a silhouette point by point and hands it back in radius units', () => {
    // A unit square around the centre. Under the identity the ring comes back
    // unchanged, which pins the "radius units in, radius units out" contract.
    const outline = [1, 1, -1, 1, -1, -1, 1, -1];
    const mapped = mapCanonicalHoldsToPhoto(IDENTITY_HOMOGRAPHY, [{ id: 1, cx: 500, cy: 400, r: 20, outline }]);
    expect(mapped![0].outline).toHaveLength(8);
    for (let index = 0; index < outline.length; index++) {
      expect(mapped![0].outline![index]).toBeCloseTo(outline[index], 6);
    }
  });

  it('divides the outline by the MAPPED radius, not the stored one', () => {
    // Two identical circular silhouettes, one where the map compresses and one
    // where it does not. With the correct denominator BOTH come back at ~1 radius,
    // because each is divided by the radius it was mapped TO. Divide by the
    // stored radius instead and each ring comes back at its own local scale
    // factor, so the two disagree — no magic number needed, and it is exactly the
    // mutation the identity-matrix case above cannot see.
    const circle: number[] = [];
    for (let step = 0; step < 16; step++) {
      const angle = (step / 16) * 2 * Math.PI;
      circle.push(Math.cos(angle), Math.sin(angle));
    }
    const mapped = mapCanonicalHoldsToPhoto(PHOTO_TO_CANONICAL, [
      { id: 1, cx: 60, cy: 400, r: 20, outline: circle },
      { id: 2, cx: 940, cy: 400, r: 20, outline: circle },
    ]);

    // The two holds really are at different local scales, or this proves nothing.
    expect(mapped![0].r).not.toBeCloseTo(mapped![1].r, 2);

    const meanRingRadius = (outline: number[]) => {
      let total = 0;
      for (let index = 0; index + 1 < outline.length; index += 2) {
        total += Math.hypot(outline[index], outline[index + 1]);
      }
      return total / (outline.length / 2);
    };
    expect(meanRingRadius(mapped![0].outline!)).toBeCloseTo(1, 1);
    expect(meanRingRadius(mapped![1].outline!)).toBeCloseTo(1, 1);
  });

  it('distorts a silhouette with the wall it sits on', () => {
    const outline = [1, 1, -1, 1, -1, -1, 1, -1];
    const mapped = mapCanonicalHoldsToPhoto(PHOTO_TO_CANONICAL, [{ id: 1, cx: 940, cy: 120, r: 24, outline }]);
    // Same square, now seen at an angle: at least one coordinate has to have
    // moved, or the ring was scaled rather than mapped.
    expect(mapped![0].outline!.some((value, index) => Math.abs(value - outline[index]) > 1e-6)).toBe(true);
  });

  it('drops a silhouette that maps outside the stored-ring bounds instead of storing a broken one', () => {
    // Four radii is the contract's ceiling. A ring this wide would be rejected by
    // `isValidOutlineRing` downstream; the hold itself must survive as a circle.
    const mapped = mapCanonicalHoldsToPhoto(IDENTITY_HOMOGRAPHY, [
      { id: 1, cx: 500, cy: 400, r: 20, outline: [9, 9, -9, 9, -9, -9, 9, -9] },
    ]);
    expect(mapped![0].outline).toBeUndefined();
    expect(mapped![0]).toMatchObject({ id: 1, cx: 500, cy: 400, r: 20 });
  });

  it('ignores a ring too short to be a triangle', () => {
    const mapped = mapCanonicalHoldsToPhoto(IDENTITY_HOMOGRAPHY, [
      { id: 1, cx: 500, cy: 400, r: 20, outline: [1, 0, 0, 1] },
    ]);
    expect(mapped![0].outline).toBeUndefined();
  });

  it('refuses the whole wall when the stored matrix has no inverse', () => {
    // All zeros: singular. Drawing holds at their canonical coordinates on top of
    // a photo they do not belong to is plausible-looking and completely wrong, so
    // the honest answer is no wall.
    expect(mapCanonicalHoldsToPhoto([0, 0, 0, 0, 0, 0, 0, 0, 0], [{ id: 1, cx: 1, cy: 1, r: 1 }])).toBeNull();
  });

  it('drops one unmappable hold without losing the rest', () => {
    // A matrix whose horizon runs through the wall: the point on it maps to
    // infinity, its neighbours do not.
    const withHorizon = [1, 0, 0, 0, 1, 0, 0, 0.01, -5];
    const mapped = mapCanonicalHoldsToPhoto(withHorizon, [
      { id: 1, cx: 100, cy: 100, r: 10 },
      { id: 2, cx: 100, cy: 500, r: 10 },
      { id: 3, cx: 100, cy: 900, r: 10 },
    ]);
    expect(mapped).not.toBeNull();
    expect(mapped!.length).toBeGreaterThan(0);
    expect(mapped!.every((hold) => Number.isFinite(hold.cx) && Number.isFinite(hold.cy) && hold.r >= 1)).toBe(true);
  });
});
