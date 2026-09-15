// The 4-point DLT behind every spray-wall version's geometry.
//
// Two photographs of the same wall only agree on where a hold is because of this
// matrix, so a wrong one silently moves every hold on the wall rather than
// failing anything. The cases below pin a KNOWN quad to a KNOWN matrix (the
// identity case and a translate/scale case are hand-checkable), plus the round
// trip that actually matters: each anchor must land exactly on its corner of the
// canonical rectangle.
//
// Moved from `packages/backend/src/__tests__/spray-wall-homography.test.ts`
// (SW-05, #5438) with the module, as that file said it would be. The `invert` /
// `mapRing` / `mapRadius` blocks at the bottom are new.
import { describe, expect, it } from 'vite-plus/test';
import {
  IDENTITY_HOMOGRAPHY,
  type Quad,
  boundingSize,
  homographyFromAnchors,
  invert,
  isSolvableAnchorQuad,
  isValidAnchorQuad,
  mapPoint,
  mapRadius,
  mapRing,
} from '../homography';

const UNIT_FRAME = { width: 100, height: 200 };

/** The four corners of `frame`, in the TL/TR/BR/BL order anchors are stored in. */
function frameQuad({ width, height }: { width: number; height: number }): Quad {
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
}

/** A photo taken hard off to one side: the wall is a genuine trapezoid. */
const PERSPECTIVE_QUAD: Quad = [
  [120, 80],
  [900, 140],
  [860, 700],
  [160, 640],
];

describe('homographyFromAnchors', () => {
  it('returns the identity when there are no anchors', () => {
    // A version whose photo IS its frame stores the identity, and that is what
    // every version created without anchors gets.
    expect(homographyFromAnchors(null, UNIT_FRAME)).toEqual(IDENTITY_HOMOGRAPHY);
    expect(homographyFromAnchors(undefined, UNIT_FRAME)).toEqual(IDENTITY_HOMOGRAPHY);
  });

  it('returns the identity for a quad that is not four finite points', () => {
    expect(homographyFromAnchors([[0, 0]], UNIT_FRAME)).toEqual(IDENTITY_HOMOGRAPHY);
    expect(
      homographyFromAnchors(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [Number.NaN, 1],
        ],
        UNIT_FRAME,
      ),
    ).toEqual(IDENTITY_HOMOGRAPHY);
    expect(homographyFromAnchors('not a quad', UNIT_FRAME)).toEqual(IDENTITY_HOMOGRAPHY);
  });

  it('solves the identity matrix when the anchors already ARE the frame', () => {
    // Hand-checkable: mapping (0,0)-(100,200) onto (0,0)-(100,200) is the
    // identity, so any drift here is the solver itself being wrong.
    const solved = homographyFromAnchors(frameQuad(UNIT_FRAME), UNIT_FRAME);
    solved.forEach((value, index) => expect(value).toBeCloseTo(IDENTITY_HOMOGRAPHY[index], 9));
  });

  it('solves a pure scale to a known matrix', () => {
    // A photo twice the canonical size: every anchor is at 2x its canonical
    // corner, so the map is a halving with no projective part at all.
    const quad: Quad = [
      [0, 0],
      [200, 0],
      [200, 400],
      [0, 400],
    ];
    const expected = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
    homographyFromAnchors(quad, UNIT_FRAME).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9));
  });

  it('solves a translate to a known matrix', () => {
    // The wall sits 30px right and 10px down in the photo, so the map subtracts
    // exactly that and the third column carries the offset.
    const quad: Quad = [
      [30, 10],
      [130, 10],
      [130, 210],
      [30, 210],
    ];
    const expected = [1, 0, -30, 0, 1, -10, 0, 0, 1];
    homographyFromAnchors(quad, UNIT_FRAME).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9));
  });

  it('maps every anchor of a perspective quad onto its own corner', () => {
    // The real case. The fit is exact for four correspondences, so each anchor
    // must land ON its corner — not near it.
    const homography = homographyFromAnchors(PERSPECTIVE_QUAD, UNIT_FRAME);
    const corners = frameQuad(UNIT_FRAME);

    PERSPECTIVE_QUAD.forEach((anchor, index) => {
      const [x, y] = mapPoint(homography, anchor[0], anchor[1]);
      expect(x).toBeCloseTo(corners[index][0], 6);
      expect(y).toBeCloseTo(corners[index][1], 6);
    });

    // A genuinely projective quad has a non-zero bottom row; an affine-only
    // solver would pass the corner checks above on a parallelogram but not here.
    expect(Math.abs(homography[6]) + Math.abs(homography[7])).toBeGreaterThan(0);
  });

  it('falls back to the identity for a degenerate quad', () => {
    // Four collinear anchors describe no quadrilateral. The identity is a worse
    // map than a correct one and a far better outcome than a matrix of NaN,
    // which would render every hold on the wall at nowhere.
    const collinear: Quad = [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ];
    expect(homographyFromAnchors(collinear, UNIT_FRAME)).toEqual(IDENTITY_HOMOGRAPHY);

    const coincident: Quad = [
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 5],
    ];
    expect(homographyFromAnchors(coincident, UNIT_FRAME)).toEqual(IDENTITY_HOMOGRAPHY);
  });

  it('refuses a non-positive reference size rather than dividing by it', () => {
    expect(homographyFromAnchors(frameQuad(UNIT_FRAME), { width: 0, height: 200 })).toEqual(IDENTITY_HOMOGRAPHY);
    expect(homographyFromAnchors(frameQuad(UNIT_FRAME), { width: 100, height: -5 })).toEqual(IDENTITY_HOMOGRAPHY);
  });
});

describe('boundingSize', () => {
  it('rounds the quad box out to whole pixels', () => {
    expect(
      boundingSize([
        [10.2, 20.4],
        [110.6, 19.8],
        [109.4, 220.1],
        [11.1, 221.7],
      ]),
    ).toEqual({ width: 100, height: 202 });
  });

  it('never returns a zero dimension', () => {
    // A frame of width 0 would make every hold coordinate a division by zero
    // downstream, so the floor is 1 even for a collapsed quad.
    expect(
      boundingSize([
        [5, 5],
        [5, 5],
        [5, 5],
        [5, 5],
      ]),
    ).toEqual({ width: 1, height: 1 });
  });
});

describe('isValidAnchorQuad', () => {
  it('accepts four finite pairs and nothing else', () => {
    expect(isValidAnchorQuad(frameQuad(UNIT_FRAME))).toBe(true);
    expect(isValidAnchorQuad([])).toBe(false);
    expect(
      isValidAnchorQuad([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toBe(false);
    expect(
      isValidAnchorQuad([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, Number.POSITIVE_INFINITY],
      ]),
    ).toBe(false);
    expect(
      isValidAnchorQuad([
        ['0', '0'],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBe(false);
  });
});

describe('isSolvableAnchorQuad', () => {
  it('accepts a photo taken hard off to one side', () => {
    expect(isSolvableAnchorQuad(PERSPECTIVE_QUAD)).toBe(true);
  });

  it('refuses a quad smaller than 8px on a side', () => {
    expect(
      isSolvableAnchorQuad([
        [0, 0],
        [7, 0],
        [7, 100],
        [0, 100],
      ]),
    ).toBe(false);
  });

  it('refuses a quad with almost no area inside its own box', () => {
    // A bow-tie of four taps along a diagonal: the bounding box is big, the
    // enclosed area is not. Accepting it would pin a useless canonical frame on
    // the wall forever.
    expect(
      isSolvableAnchorQuad([
        [0, 0],
        [1000, 1000],
        [1000, 1002],
        [0, 2],
      ]),
    ).toBe(false);
  });
});

describe('invert', () => {
  it('round-trips a point through both directions', () => {
    const forward = homographyFromAnchors(PERSPECTIVE_QUAD, UNIT_FRAME);
    const back = invert(forward);
    for (const [x, y] of [
      [400, 300],
      [130, 90],
      [850, 690],
    ]) {
      const [canonicalX, canonicalY] = mapPoint(forward, x, y);
      const [photoX, photoY] = mapPoint(back, canonicalX, canonicalY);
      expect(photoX).toBeCloseTo(x, 6);
      expect(photoY).toBeCloseTo(y, 6);
    }
  });

  it('inverts the identity to itself', () => {
    expect(invert(IDENTITY_HOMOGRAPHY)).toEqual(IDENTITY_HOMOGRAPHY);
  });

  it('returns the identity for a singular matrix', () => {
    // Nothing renders from NaN; the same rule as homographyFromAnchors.
    expect(invert([1, 2, 3, 2, 4, 6, 3, 6, 9])).toEqual(IDENTITY_HOMOGRAPHY);
  });
});

describe('mapRing and mapRadius', () => {
  it('maps a ring point by point, not as a rigid shape', () => {
    const homography = homographyFromAnchors(PERSPECTIVE_QUAD, UNIT_FRAME);
    // A square in the photo, near the far (compressed) edge of the wall.
    const ring = [820, 180, 860, 180, 860, 220, 820, 220];
    const mapped = mapRing(homography, ring);
    expect(mapped).toHaveLength(8);
    mapped.forEach((value) => expect(Number.isFinite(value)).toBe(true));

    // Under a projective map the square's opposite edges no longer match.
    const topEdge = Math.hypot(mapped[2] - mapped[0], mapped[3] - mapped[1]);
    const bottomEdge = Math.hypot(mapped[4] - mapped[6], mapped[5] - mapped[7]);
    expect(topEdge).not.toBeCloseTo(bottomEdge, 6);
  });

  it('leaves a ring unchanged through the identity', () => {
    expect(mapRing(IDENTITY_HOMOGRAPHY, [0, 0, 1, 0, 1, 1])).toEqual([0, 0, 1, 0, 1, 1]);
  });

  it('scales a radius by the square root of a pure scale', () => {
    // Halving both axes quarters the area, so an area-preserving radius halves.
    const halving = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
    expect(mapRadius(halving, 10, 10)).toBeCloseTo(0.5, 9);
    expect(mapRadius(IDENTITY_HOMOGRAPHY, 10, 10)).toBeCloseTo(1, 9);
  });

  it('shrinks the far side of a wall more than the near side', () => {
    // The whole reason mapRadius exists: a hold at the compressed end of the
    // photo has to come out smaller in canonical space than one at the near end,
    // or every wall shot off-axis renders with evenly sized holds on a skewed
    // grid.
    const homography = homographyFromAnchors(PERSPECTIVE_QUAD, UNIT_FRAME);
    const near = mapRadius(homography, 200, 400);
    const far = mapRadius(homography, 850, 400);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near).not.toBeCloseTo(far, 4);
  });

  it('returns 1 where the map is singular rather than 0 or NaN', () => {
    expect(mapRadius([1, 0, 0, 0, 1, 0, 1, 0, -10], 10, 0)).toBe(1);
  });
});
