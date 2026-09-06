import { describe, it, expect } from 'vite-plus/test';
import {
  circleIntersectsPolygon,
  clampCentreToPanel,
  clientToWallMm,
  findCollisions,
  polygonCrossesLine,
  resizeKeepingAspect,
  rotateFromPointer,
  rotatedRectCorners,
  segmentIntersectsSegment,
  snapToGrid,
  type HoleMm,
  type PanelRectMm,
  type SeamLineMm,
} from '../configurator/placement-editor/geometry';

/**
 * The millimetre maths the placement editor draws its live verdict from.
 *
 * Worth testing without a DOM because it is the half of the editor that decides
 * whether somebody is allowed to buy: a keep-out test that says "clear" when a
 * label is sitting on a T-nut sells a pack the generator then refuses to build.
 */

const PANEL: PanelRectMm = { index: 0, xMm: 0, yMm: 0, widthMm: 1000, heightMm: 500 };

describe('rotatedRectCorners', () => {
  it('gives the four corners counter-clockwise from bottom-left', () => {
    expect(rotatedRectCorners({ xMm: 0, yMm: 0 }, 100, 40, 0)).toEqual([
      { xMm: -50, yMm: -20 },
      { xMm: 50, yMm: -20 },
      { xMm: 50, yMm: 20 },
      { xMm: -50, yMm: 20 },
    ]);
  });

  it('turns counter-clockwise, like the generator does', () => {
    const [bottomLeft] = rotatedRectCorners({ xMm: 0, yMm: 0 }, 100, 40, 90);
    expect(bottomLeft.xMm).toBeCloseTo(20, 6);
    expect(bottomLeft.yMm).toBeCloseTo(-50, 6);
  });
});

describe('snapToGrid', () => {
  it('rounds to the nearest 10 mm', () => {
    expect(snapToGrid(37)).toBe(40);
    expect(snapToGrid(34)).toBe(30);
    expect(snapToGrid(-34)).toBe(-30);
  });

  it('leaves a value alone when the step is nonsense', () => {
    expect(snapToGrid(37, 0)).toBe(37);
  });
});

describe('circleIntersectsPolygon', () => {
  const label = rotatedRectCorners({ xMm: 0, yMm: 0 }, 100, 40, 0);

  it('catches a hole underneath the label', () => {
    expect(circleIntersectsPolygon({ xMm: 0, yMm: 0 }, 1, label)).toBe(true);
  });

  it('catches a hole whose keep-out reaches the label', () => {
    expect(circleIntersectsPolygon({ xMm: 55, yMm: 0 }, 10, label)).toBe(true);
  });

  it('leaves a hole further off than its keep-out alone', () => {
    expect(circleIntersectsPolygon({ xMm: 70, yMm: 0 }, 10, label)).toBe(false);
  });
});

describe('segmentIntersectsSegment', () => {
  it('sees a crossing', () => {
    expect(
      segmentIntersectsSegment({ xMm: -1, yMm: 0 }, { xMm: 1, yMm: 0 }, { xMm: 0, yMm: -1 }, { xMm: 0, yMm: 1 }),
    ).toBe(true);
  });

  it('counts touching as contact, because the generator does', () => {
    expect(
      segmentIntersectsSegment({ xMm: -1, yMm: 0 }, { xMm: 0, yMm: 0 }, { xMm: 0, yMm: -1 }, { xMm: 0, yMm: 1 }),
    ).toBe(true);
  });

  it('leaves two segments that miss', () => {
    expect(
      segmentIntersectsSegment({ xMm: -2, yMm: 0 }, { xMm: -1, yMm: 0 }, { xMm: 0, yMm: -1 }, { xMm: 0, yMm: 1 }),
    ).toBe(false);
  });
});

describe('polygonCrossesLine', () => {
  const label = rotatedRectCorners({ xMm: 0, yMm: 0 }, 100, 40, 0);

  it('catches a label sitting on a seam', () => {
    expect(polygonCrossesLine(label, { kind: 'vertical', valueMm: 0, extent: [-100, 100] })).toBe(true);
  });

  it('leaves a seam the label is nowhere near', () => {
    expect(polygonCrossesLine(label, { kind: 'vertical', valueMm: 200, extent: [-100, 100] })).toBe(false);
  });

  it('leaves a seam that stops before the label starts', () => {
    expect(polygonCrossesLine(label, { kind: 'vertical', valueMm: 0, extent: [100, 200] })).toBe(false);
  });

  it('catches a short seam sitting entirely under the label', () => {
    expect(polygonCrossesLine(label, { kind: 'vertical', valueMm: 0, extent: [-5, 5] })).toBe(true);
  });

  it('catches a horizontal seam too', () => {
    expect(polygonCrossesLine(label, { kind: 'horizontal', valueMm: 10, extent: [-100, 100] })).toBe(true);
  });
});

describe('clampCentreToPanel', () => {
  it('pushes a label back inside the panel margin', () => {
    expect(clampCentreToPanel({ xMm: 0, yMm: 0, widthMm: 100, heightMm: 50, rotationDeg: 0 }, PANEL, 15)).toEqual({
      xMm: 65,
      yMm: 40,
    });
  });

  it('clamps against the ROTATED bounds, so a turned label cannot poke out', () => {
    const clamped = clampCentreToPanel({ xMm: 0, yMm: 0, widthMm: 100, heightMm: 50, rotationDeg: 90 }, PANEL, 15);
    expect(clamped.xMm).toBeCloseTo(40, 6);
    expect(clamped.yMm).toBeCloseTo(65, 6);
  });

  it('parks a label too big for its panel in the middle', () => {
    const clamped = clampCentreToPanel({ xMm: 0, yMm: 0, widthMm: 4000, heightMm: 50, rotationDeg: 0 }, PANEL, 15);
    expect(clamped.xMm).toBe(500);
  });
});

describe('resizeKeepingAspect', () => {
  const start = { xMm: 0, yMm: 0, widthMm: 100, heightMm: 50, rotationDeg: 0 };

  it('keeps the opposite corner still and the aspect locked', () => {
    expect(resizeKeepingAspect('bottomRight', { xMm: 100, yMm: -25 }, start, 2, 40, 1200)).toEqual({
      xMm: 25,
      yMm: -12.5,
      widthMm: 150,
    });
  });

  it('will not shrink below the catalogue floor', () => {
    expect(resizeKeepingAspect('bottomRight', { xMm: -49, yMm: -25 }, start, 2, 40, 1200).widthMm).toBe(40);
  });

  it('will not grow past the catalogue ceiling', () => {
    expect(resizeKeepingAspect('bottomRight', { xMm: 9000, yMm: -25 }, start, 2, 40, 1200).widthMm).toBe(1200);
  });

  it('resizes along the edges of a rotated label', () => {
    const rotated = { ...start, rotationDeg: 90 };
    const resized = resizeKeepingAspect('bottomRight', { xMm: 25, yMm: 100 }, rotated, 2, 40, 1200);
    expect(resized.widthMm).toBe(150);
  });
});

describe('rotateFromPointer', () => {
  it('reads straight up from the centre as no rotation', () => {
    expect(rotateFromPointer({ xMm: 0, yMm: 0 }, { xMm: 0, yMm: 100 }, false)).toBe(0);
  });

  it('reads a pointer to the right as a quarter turn clockwise', () => {
    expect(rotateFromPointer({ xMm: 0, yMm: 0 }, { xMm: 100, yMm: 0 }, false)).toBe(-90);
  });

  it('snaps to 15 degrees when asked', () => {
    const radians = (100 * Math.PI) / 180;
    const pointer = { xMm: Math.cos(radians) * 100, yMm: Math.sin(radians) * 100 };
    expect(rotateFromPointer({ xMm: 0, yMm: 0 }, pointer, true)).toBe(15);
  });
});

describe('findCollisions', () => {
  const holes: HoleMm[] = [
    { id: 'tnut-0', xMm: 500, yMm: 250, keepoutRadiusMm: 20 },
    { id: 'led-1', xMm: 900, yMm: 400, keepoutRadiusMm: 12 },
  ];
  const seams: SeamLineMm[] = [{ kind: 'vertical', valueMm: 505, extent: [0, 500] }];

  it('names the holes in the way and the seams it spans', () => {
    const collisions = findCollisions(
      { xMm: 500, yMm: 250, widthMm: 100, heightMm: 50, rotationDeg: 0 },
      PANEL,
      holes,
      seams,
      { panelEdgeMarginMm: 15, keepoutScale: 1 },
    );
    expect(collisions).toEqual({ holes: ['tnut-0'], seams: [0], offPanel: false });
  });

  it('finds nothing for a label parked in a clear corner', () => {
    const collisions = findCollisions(
      { xMm: 200, yMm: 100, widthMm: 100, heightMm: 50, rotationDeg: 0 },
      PANEL,
      holes,
      [],
      { panelEdgeMarginMm: 15, keepoutScale: 1 },
    );
    expect(collisions).toEqual({ holes: [], seams: [], offPanel: false });
  });

  it('holds a cut-through further off the same hole', () => {
    const rect = { xMm: 545, yMm: 250, widthMm: 40, heightMm: 20, rotationDeg: 0 };
    expect(findCollisions(rect, PANEL, holes, [], { panelEdgeMarginMm: 15, keepoutScale: 1 }).holes).toEqual([]);
    expect(findCollisions(rect, PANEL, holes, [], { panelEdgeMarginMm: 15, keepoutScale: 1.5 }).holes).toEqual([
      'tnut-0',
    ]);
  });

  it('reports off-panel when a corner leaves the margin, and when there is no panel at all', () => {
    const rect = { xMm: 20, yMm: 250, widthMm: 100, heightMm: 50, rotationDeg: 0 };
    expect(findCollisions(rect, PANEL, [], [], { panelEdgeMarginMm: 15, keepoutScale: 1 }).offPanel).toBe(true);
    expect(findCollisions(rect, null, [], [], { panelEdgeMarginMm: 15, keepoutScale: 1 }).offPanel).toBe(true);
  });
});

describe('clientToWallMm', () => {
  const viewBox = { minXMm: 0, minYMm: -100, widthMm: 100, heightMm: 100 };

  it('maps a pointer into wall millimetres, y flipped', () => {
    expect(clientToWallMm({ left: 0, top: 0, width: 100, height: 100 }, viewBox, 50, 50)).toEqual({
      xMm: 50,
      yMm: 50,
    });
  });

  it('answers the middle of the wall rather than NaN for an unlaid-out canvas', () => {
    expect(clientToWallMm({ left: 0, top: 0, width: 0, height: 0 }, viewBox, 50, 50)).toEqual({
      xMm: 50,
      yMm: 50,
    });
  });
});
