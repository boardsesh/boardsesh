// What the look picker needs to draw "Wall only" and "Holds only" on the phone,
// before the backend has made either (`docs/spray-walls.md`, "Previewing a look
// on the phone").
//
// Pure: the picker's tiles read one `SprayLookPreviewSource` and these helpers,
// and the transform maths itself is `@boardsesh/spray-wall-geometry`'s
// `look-preview.ts`, next to the job's own warp.

import { artFeather, holdMaskRings, type Homography, type ReferenceSize } from '@boardsesh/spray-wall-geometry';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';

/** One hold in the canonical frame, as the mask needs it. */
export type SprayLookPreviewHold = { cx: number; cy: number; r: number; outline?: readonly number[] | null };

/** One version's photo, its map onto the wall's frame, and its holds. */
export type SprayLookPreviewSource = {
  photoUrl: string;
  photo: ReferenceSize;
  /** Row-major photo -> canonical homography. */
  homography: Homography;
  /** The canonical frame (`boardWidth` x `boardHeight`). */
  frame: ReferenceSize;
  holds: readonly SprayLookPreviewHold[];
};

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The preview source a render payload gives, or null when it cannot be drawn:
 * no photo size, no frame, or a homography that is not nine finite numbers.
 */
export function lookPreviewSourceFromRenderData(
  renderData:
    | Pick<SprayWallRenderData, 'boardWidth' | 'boardHeight' | 'homography' | 'photo' | 'holds'>
    | null
    | undefined,
): SprayLookPreviewSource | null {
  if (!renderData) return null;
  const { boardWidth, boardHeight, homography, photo, holds } = renderData;
  if (!positive(boardWidth) || !positive(boardHeight)) return null;
  if (!photo?.url || !positive(photo.width) || !positive(photo.height)) return null;
  if (!Array.isArray(homography) || homography.length !== 9 || !homography.every(Number.isFinite)) return null;
  return {
    photoUrl: photo.url,
    photo: { width: photo.width, height: photo.height },
    homography: [...homography],
    frame: { width: boardWidth, height: boardHeight },
    holds: holds.map(({ cx, cy, r, outline }) => ({ cx, cy, r, outline: outline ?? null })),
  };
}

/**
 * One tile's size: as wide as the slot allows, at the frame's aspect, and no
 * taller than `maxHeight` (a tall wall gets a narrower tile instead). Whole
 * points, so the transform and the mask land on the same pixels.
 */
export function lookPreviewTileSize(frame: ReferenceSize, slotWidth: number, maxHeight: number): ReferenceSize | null {
  if (!positive(frame.width) || !positive(frame.height) || !positive(slotWidth) || !positive(maxHeight)) return null;
  const aspect = frame.width / frame.height;
  let width = slotWidth;
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  return { width, height };
}

/**
 * The "Holds only" mask in tile pixels: one SVG path of every hold outline,
 * the stroke that grows it (the job's dilation), and a wider soft stroke that
 * stands in for the job's Gaussian feather. One path for every hold, so a
 * wall of 300 holds is still two SVG elements.
 */
export type LookPreviewMask = { path: string; grow: number; feather: number };

export function lookPreviewMask(holds: readonly SprayLookPreviewHold[], scale: number): LookPreviewMask | null {
  if (!positive(scale)) return null;
  const rings = holdMaskRings(holds, scale);
  if (rings.length === 0) return null;
  let path = '';
  for (const { points } of rings) {
    if (points.length < 6) continue;
    path += `M${points[0].toFixed(1)} ${points[1].toFixed(1)}`;
    for (let index = 2; index + 1 < points.length; index += 2) {
      path += `L${points[index].toFixed(1)} ${points[index + 1].toFixed(1)}`;
    }
    path += 'Z';
  }
  if (!path) return null;
  const grows = rings.map((ring) => ring.grow).sort((left, right) => left - right);
  const grow = grows[Math.floor(grows.length / 2)];
  return {
    path,
    grow,
    feather: artFeather(
      holds.map((hold) => hold.r),
      scale,
    ),
  };
}
