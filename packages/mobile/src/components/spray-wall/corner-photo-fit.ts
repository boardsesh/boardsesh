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
