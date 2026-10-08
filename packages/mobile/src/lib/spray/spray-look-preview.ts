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
  /** The photo cache's identity for this version (`spray-photo-cache.ts`). */
  layoutId: number;
  versionId: number;
  /** Presigned GET for the photo: only ever DOWNLOADED from, never drawn from directly on native. */
  photoUrl: string;
  photoExpiresAt: string;
  photo: ReferenceSize;
  /** Row-major photo -> canonical homography. */
  homography: Homography;
  /** The canonical frame (`boardWidth` x `boardHeight`). */
  frame: ReferenceSize;
  holds: readonly SprayLookPreviewHold[];
};

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The preview source a render payload gives for one version, or null when it
 * cannot be drawn: no version id, no photo size, no frame, or a homography
 * that is not nine finite numbers.
 */
export function lookPreviewSourceFromRenderData(
  renderData:
    | Pick<SprayWallRenderData, 'boardWidth' | 'boardHeight' | 'homography' | 'photo' | 'holds'>
    | null
    | undefined,
  identity: { layoutId: number; versionId: number | string | null | undefined },
): SprayLookPreviewSource | null {
  if (!renderData) return null;
  const versionId = Number(identity.versionId);
  if (!Number.isSafeInteger(versionId) || versionId <= 0 || !Number.isSafeInteger(identity.layoutId)) return null;
  const { boardWidth, boardHeight, homography, photo, holds } = renderData;
  if (!positive(boardWidth) || !positive(boardHeight)) return null;
  if (!photo?.url || !positive(photo.width) || !positive(photo.height)) return null;
  if (!Array.isArray(homography) || homography.length !== 9 || !homography.every(Number.isFinite)) return null;
  return {
    layoutId: identity.layoutId,
    versionId,
    photoUrl: photo.url,
    photoExpiresAt: photo.expiresAt,
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

/**
 * Whether a URI names a file on this device. The Android mesh draws through
 * react-native-svg's image loader, which keeps a DISK cache for anything it
 * fetches over the network; a local file it only decodes. So the mesh draws a
 * photo only from here, never from a presigned URL.
 */
export function isLocalFileUri(uri: string | null | undefined): uri is string {
  return typeof uri === 'string' && uri.startsWith('file:///');
}

/**
 * The URI an image should load a cached photo from: a native cache PATH
 * (`ensureSprayPhotoCached` strips the scheme for the board decoders) gets
 * `file://` back; anything else (the browser's presigned URL) is kept.
 */
export function cachedPhotoUri(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  return pathOrUrl.startsWith('/') ? `file://${pathOrUrl}` : pathOrUrl;
}

/** Opacity of the soft stroke that stands in for the job's feather. */
export const LOOK_PREVIEW_FEATHER_OPACITY = 0.4;

/**
 * The same mask as a standalone SVG document in a data URI, for the browser,
 * where `MaskedView` drops its children and CSS `mask-image` does the job.
 * Black is opaque in a luminance-free alpha mask, as in `MaskedView`.
 */
export function lookPreviewMaskSvgDataUri(mask: LookPreviewMask, tile: ReferenceSize): string {
  const soft = 2 * (mask.grow + mask.feather);
  const hard = 2 * mask.grow;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${tile.height}" ` +
    `viewBox="0 0 ${tile.width} ${tile.height}">` +
    `<path d="${mask.path}" fill="#000" stroke="#000" stroke-opacity="${LOOK_PREVIEW_FEATHER_OPACITY}" ` +
    `stroke-width="${soft}" stroke-linejoin="round"/>` +
    `<path d="${mask.path}" fill="#000" stroke="#000" stroke-width="${hard}" stroke-linejoin="round"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
