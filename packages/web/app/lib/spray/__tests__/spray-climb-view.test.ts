import { describe, expect, it, vi } from 'vite-plus/test';
import { buildSprayLitHoldMarks, resolveSprayPhotoFrame } from '../spray-climb-view';

/**
 * The drawing half of a spray climb page: which holds get a mark, where the
 * mark lands on the photograph, and what happens when the wall's stored
 * geometry is unusable.
 */

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A 2x scale photo→canonical matrix: canonical 200 is photo 100. */
const DOUBLE_SCALE = [2, 0, 0, 0, 2, 0, 0, 0, 1];

const HOLDS = [
  { id: 101, cx: 200, cy: 400, r: 20, outline: null },
  { id: 102, cx: 600, cy: 800, r: 30, outline: [-1, -1, 1, -1, 1, 1, -1, 1] },
  { id: 103, cx: 900, cy: 100, r: 25, outline: null },
];

describe('buildSprayLitHoldMarks', () => {
  it('marks only the holds the frames light, in the spray role colours', () => {
    // p101r1 = STARTING (green), p102r3 = FINISH (red). 103 is on the wall and
    // not in this climb, so it must not be drawn.
    const marks = buildSprayLitHoldMarks({ holds: HOLDS, homography: IDENTITY, frames: 'p101r1p102r3' });

    expect(marks.map((mark) => mark.id)).toEqual([101, 102]);
    expect(marks.map((mark) => mark.role)).toEqual(['STARTING', 'FINISH']);
    expect(marks[0].color).toBe('#00DD00');
    expect(marks[1].color).toBe('#FF0000');
  });

  it('maps centres and radii through the INVERSE of the stored matrix', () => {
    // The stored matrix is photo -> canonical, so a canonical hold at 200/400
    // under a 2x matrix sits at 100/200 in the photograph, at half the radius.
    const [mark] = buildSprayLitHoldMarks({ holds: HOLDS, homography: DOUBLE_SCALE, frames: 'p101r1' });

    expect(mark.cx).toBe(100);
    expect(mark.cy).toBe(200);
    expect(mark.r).toBe(10);
  });

  it('draws a traced hold as a polygon and an untraced one as a circle', () => {
    const marks = buildSprayLitHoldMarks({ holds: HOLDS, homography: IDENTITY, frames: 'p101r2p102r2' });
    const [untraced, traced] = marks;

    expect(untraced.polygonPoints).toBeNull();
    // Ring units are radii around the hold's own centre: (-1, -1) on a r=30
    // hold at 600/800 is canonical 570/770, which the identity leaves alone.
    expect(traced.polygonPoints).toBe('570,770 630,770 630,830 570,830');
  });

  it('renders no marks rather than throwing when the wall matrix is singular', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every row a multiple of the first: no inverse exists.
    const singular = [1, 2, 3, 2, 4, 6, 3, 6, 9];

    expect(buildSprayLitHoldMarks({ holds: HOLDS, homography: singular, frames: 'p101r1' })).toEqual([]);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('drops a hold the map sends to infinity rather than drawing it in the corner', () => {
    // Invertible, but its INVERSE puts the vanishing line right through the
    // wall: the hold at canonical y=400 divides by a homogeneous w of zero. A
    // browser reads cx="NaN" as 0 and would draw the mark at the photo's edge,
    // showing a hold this climb does not use.
    const vanishing = [1, 0, 0, 0, 1, 0, 0, 1 / 400, 1];

    const marks = buildSprayLitHoldMarks({ holds: HOLDS, homography: vanishing, frames: 'p101r1p102r3' });

    expect(marks.map((mark) => mark.id)).toEqual([102]);
    expect(marks.every((mark) => Number.isFinite(mark.cx) && Number.isFinite(mark.cy))).toBe(true);
  });

  it('treats a missing or malformed matrix as the identity', () => {
    const [fromNull] = buildSprayLitHoldMarks({ holds: HOLDS, homography: null, frames: 'p101r1' });
    const [fromShort] = buildSprayLitHoldMarks({ holds: HOLDS, homography: [1, 0, 0], frames: 'p101r1' });

    expect(fromNull.cx).toBe(200);
    expect(fromShort.cx).toBe(200);
  });

  it('has nothing to draw for a climb with no frames', () => {
    expect(buildSprayLitHoldMarks({ holds: HOLDS, homography: IDENTITY, frames: '' })).toEqual([]);
  });
});

describe('resolveSprayPhotoFrame', () => {
  it('uses the photo box, because canonical is not the photo on an anchored wall', () => {
    expect(
      resolveSprayPhotoFrame({ photoWidth: 3000, photoHeight: 4000, boardWidth: 1200, boardHeight: 1600 }),
    ).toEqual({ width: 3000, height: 4000 });
  });

  it('falls back to the canonical frame when the version stored no photo size', () => {
    expect(
      resolveSprayPhotoFrame({ photoWidth: null, photoHeight: null, boardWidth: 1200, boardHeight: 1600 }),
    ).toEqual({ width: 1200, height: 1600 });
  });
});
