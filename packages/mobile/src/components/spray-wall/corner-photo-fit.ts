// Where the wall photo sits on the corner step, and how a ring's position on
// screen becomes a point on the photo (epic #5346, issue #5958).
//
// The photo used to be drawn to fit the WIDTH only. A portrait photo then came
// out taller than the space between the header and the footer, the two bottom
// rings started under the fold, and the only way to reach them was to scroll in
// the same place a vertical drag moves a ring.
//
// So the photo is fitted on both axes, and it is fitted by shrinking the FRAME:
// the frame keeps the photo's exact aspect and any letterbox is outside it. That
// is what keeps the mapping one number. Render pixels are measured from the
// frame's own top-left, so a ring at (x, y) is the photo point (x / scale,
// y / scale) with no offset to carry — and no offset to get wrong.

import type { Quad } from '@boardsesh/spray-wall-geometry';

export type CornerPhotoFit = {
  /** The frame's drawn width, in points. */
  width: number;
  /** The frame's drawn height, in points. */
  height: number;
  /** Render points per photo pixel. The same number on both axes, always. */
  scale: number;
};

/**
 * Fit a photo inside a box without stretching it.
 *
 * Both dimensions come from ONE scale. Deriving the height from the width and
 * then rounding each on its own would give the two axes slightly different
 * scales, and a corner dragged to the bottom of the frame would save a few
 * pixels short of the bottom of the photo.
 *
 * Null until the box and the photo both have a size: a zero-wide frame makes the
 * photo-pixels-per-point ratio infinite, and the rings are seeded through it.
 */
export function fitCornerPhoto({
  boxWidth,
  boxHeight,
  photoWidth,
  photoHeight,
}: {
  boxWidth: number;
  boxHeight: number;
  photoWidth: number;
  photoHeight: number;
}): CornerPhotoFit | null {
  if (!(boxWidth > 0) || !(boxHeight > 0) || !(photoWidth > 0) || !(photoHeight > 0)) return null;
  const scale = Math.min(boxWidth / photoWidth, boxHeight / photoHeight);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  return { width: photoWidth * scale, height: photoHeight * scale, scale };
}

/** A quad in photo pixels, as the frame draws it. */
export function quadToRender(quad: Quad, scale: number): Quad {
  return quad.map(([pointX, pointY]) => [pointX * scale, pointY * scale]);
}

/** A quad as the frame draws it, back in photo pixels. */
export function quadToPhoto(quad: Quad, scale: number): Quad {
  return quad.map(([pointX, pointY]) => [pointX / scale, pointY / scale]);
}

/**
 * Carry one render coordinate from an old fit onto a new one.
 *
 * The frame is re-fitted when the space around it changes (a rotation, a line of
 * copy that wraps). The rings must stay on the same point of the PHOTO through
 * that, including a ring that was dragged but refused and so never reached the
 * saved quad — re-seeding from the saved quad would throw that drag away.
 */
export function rescaleRenderCoordinate(coordinate: number, fromScale: number, toScale: number): number {
  if (!(fromScale > 0) || !(toScale > 0)) return coordinate;
  return (coordinate * toScale) / fromScale;
}

/** Touch target for one corner. Bigger than the ring it draws, so a thumb can find it. */
export const CORNER_HANDLE_SIZE = 44;

/**
 * How far the photo's frame sits in from the edge of the layer the handles live
 * in, on every side.
 *
 * Half a handle, so a ring whose centre is on a true corner of the photo is
 * still whole and still inside its parent — which is what keeps it touchable.
 * The frame, the outline and the handles all take their position from
 * `cornerLayerLayout`, so they cannot come to disagree about this number.
 */
export const CORNER_FRAME_INSET = CORNER_HANDLE_SIZE / 2;

export type CornerLayerLayout = {
  /** The handle layer: the photo plus the overhang on every side. */
  layer: { width: number; height: number };
  /** Where the photo's frame (and the outline over it) sits inside that layer. */
  frame: { left: number; top: number; width: number; height: number };
  /**
   * What to add to a render coordinate to get the handle's own top-left in the
   * layer. Zero today, because the inset is exactly half a handle; it is spelled
   * out so that changing either number moves the handles with the frame.
   */
  handleOffset: number;
};

/** The geometry of the handle layer around a fitted photo. */
export function cornerLayerLayout(fit: { width: number; height: number }): CornerLayerLayout {
  return {
    layer: { width: fit.width + CORNER_FRAME_INSET * 2, height: fit.height + CORNER_FRAME_INSET * 2 },
    frame: { left: CORNER_FRAME_INSET, top: CORNER_FRAME_INSET, width: fit.width, height: fit.height },
    handleOffset: CORNER_FRAME_INSET - CORNER_HANDLE_SIZE / 2,
  };
}

/** What the marker last put on screen: which quad it was seeded with, at which scale. */
export type CornerRefitState = { seedKey: string; scale: number };

/**
 * What to do with the rings when the seed or the fit may have changed.
 *
 *  - `seed`: the saved quad itself changed (Clear, a new photo). Put the rings
 *    where it says, at the current scale. Wins over a scale change in the same
 *    render: the seed is already expressed at the new scale.
 *  - `rescale`: same quad, different fit. Carry every ring across by the ratio
 *    of the scales, so a quad that was dragged but refused is not thrown away.
 *  - `none`: nothing changed. A re-render must never move a ring.
 */
export function planCornerRefit(previous: CornerRefitState, next: CornerRefitState): 'seed' | 'rescale' | 'none' {
  if (previous.seedKey !== next.seedKey) return 'seed';
  if (previous.scale !== next.scale) return 'rescale';
  return 'none';
}
