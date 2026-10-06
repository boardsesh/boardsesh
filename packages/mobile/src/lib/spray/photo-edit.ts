// Crop and rotate a wall photo before it is uploaded, as plain arithmetic.
//
// Everything the "Crop or rotate" step decides is a `WallPhotoEdit`: a number of
// clockwise quarter turns and a crop rectangle. Nothing here touches a pixel —
// the native render is `renderWallPhotoEdit` in `wall-photo.ts`, which asks
// `planWallPhotoRender` for its operations — so every rule about which corner
// goes where after a turn, and how a fraction becomes a pixel, is a unit test
// rather than something only a phone can show.
//
// Why this is safe for the wall's coordinates: the crop happens BEFORE the
// upload. The server only ever sees the cropped file, so the anchors, the
// homography and the canonical frame are all measured in its own pixels, exactly
// as they would be for a photo that had been framed that tightly in the camera.
// A crop is not a warp (`docs/spray-walls.md`, "The frame").

/** Clockwise quarter turns: 0, 90, 180 or 270 degrees. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/**
 * A rectangle as fractions of an image, 0 at the top/left edge and 1 at the
 * bottom/right one.
 *
 * Fractions rather than pixels because the same crop is shown on a fitted
 * preview a few hundred points wide and rendered on an original thousands of
 * pixels wide; only the last step, `cropToPixels`, needs to know which.
 */
export type NormalizedRect = { left: number; top: number; right: number; bottom: number };

/**
 * Everything the step decides.
 *
 * `crop` is measured on the ROTATED image — the one the climber is looking at
 * when they drag the handles — so the render order is rotate, then crop.
 */
export type WallPhotoEdit = { quarterTurns: QuarterTurns; crop: NormalizedRect };

export type PixelSize = { width: number; height: number };

/** A crop in whole pixels, in the shape `expo-image-manipulator` takes it. */
export type PixelCrop = { originX: number; originY: number; width: number; height: number };

/** A local JPEG and its pixels. */
export type WallPhotoFile = { uri: string; width: number; height: number };

/** The file the picker handed back, before any compression. */
export type WallPhotoOriginal = {
  uri: string;
  /** Its longer side in pixels, as the picker reported it; 0 when it could not say. */
  longSide: number;
};

/**
 * A wall photo the flow can still re-edit.
 *
 * `uri`/`width`/`height` are what gets uploaded: the base when nothing was
 * edited, the rendered edit otherwise. `base` is the first compressed,
 * uncropped, oriented file — the one the crop step displays — and `original`
 * the picker's own file, which the final render reads so a crop keeps every
 * pixel the camera took. Re-editing reopens from `base` with `edit` as the
 * starting point, never from an already-cropped file.
 */
export type EditableWallPhoto = WallPhotoFile & {
  base: WallPhotoFile;
  original: WallPhotoOriginal;
  /** Null for the photo as picked. */
  edit: WallPhotoEdit | null;
};

/** The whole image. */
export const FULL_RECT: NormalizedRect = { left: 0, top: 0, right: 1, bottom: 1 };

/** No turn, no crop: the photo as picked. */
export const IDENTITY_EDIT: WallPhotoEdit = { quarterTurns: 0, crop: FULL_RECT };

/**
 * The smallest a crop may be, as a share of each side.
 *
 * A crop smaller than this is a crop of one hold, not of a wall, and the hold
 * editor zooms in by itself.
 */
export const MIN_CROP_FRACTION = 0.15;

/**
 * The fewest pixels a crop may keep on each side, measured on the base file.
 *
 * Measured on the BASE (the compressed, uncropped photo the step displays)
 * because that guarantees the output: a crop keeps at least as many pixels per
 * centimetre of wall as the uncropped photo would have, so 512 base pixels are
 * at least 512 uploaded ones.
 */
export const MIN_CROP_PIXELS = 512;

/**
 * Below this long side the step warns that holds may look soft. A warning, not
 * a gate: a small wall shot from close up can be perfectly usable at 1000 px.
 */
export const SMALL_PHOTO_LONG_SIDE = 1200;

/** Within this of an edge, a crop edge counts as the edge itself. */
const EDGE_EPSILON = 1e-6;

export function isFullRect(rect: NormalizedRect): boolean {
  return (
    rect.left <= EDGE_EPSILON &&
    rect.top <= EDGE_EPSILON &&
    rect.right >= 1 - EDGE_EPSILON &&
    rect.bottom >= 1 - EDGE_EPSILON
  );
}

/** Whether the edit changes nothing — in which case there is nothing to render. */
export function isIdentityEdit(edit: WallPhotoEdit | null | undefined): boolean {
  return edit == null || (edit.quarterTurns === 0 && isFullRect(edit.crop));
}

/** Whether two edits would render the same photo. Null is the identity. */
export function editsEqual(first: WallPhotoEdit | null | undefined, second: WallPhotoEdit | null | undefined): boolean {
  const one = first ?? IDENTITY_EDIT;
  const other = second ?? IDENTITY_EDIT;
  if (isIdentityEdit(one) && isIdentityEdit(other)) return true;
  return (
    one.quarterTurns === other.quarterTurns &&
    Math.abs(one.crop.left - other.crop.left) <= EDGE_EPSILON &&
    Math.abs(one.crop.top - other.crop.top) <= EDGE_EPSILON &&
    Math.abs(one.crop.right - other.crop.right) <= EDGE_EPSILON &&
    Math.abs(one.crop.bottom - other.crop.bottom) <= EDGE_EPSILON
  );
}

/** Whether the edit crops at all. Telemetry reads this, never the rectangle. */
export function editCrops(edit: WallPhotoEdit | null | undefined): boolean {
  return edit != null && !isFullRect(edit.crop);
}

/** Whether the edit turns the photo at all. */
export function editRotates(edit: WallPhotoEdit | null | undefined): boolean {
  return edit != null && edit.quarterTurns !== 0;
}

/** An image's size after `turns` clockwise quarter turns: odd turns swap the sides. */
export function rotatedSize(size: PixelSize, turns: QuarterTurns): PixelSize {
  return turns % 2 === 1 ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

/**
 * One more quarter turn clockwise, carrying the crop with the picture.
 *
 * The crop is drawn on the rotated image, so turning the image has to turn the
 * rectangle with it or the climber's crop would land on a different part of the
 * wall. A point at fractions (x, y) of the old image sits at (1 - y, x) of the
 * image turned 90 degrees clockwise: the left edge becomes the top, the bottom
 * edge becomes the left.
 */
export function rotateEditClockwise(edit: WallPhotoEdit): WallPhotoEdit {
  const { left, top, right, bottom } = edit.crop;
  return {
    quarterTurns: ((edit.quarterTurns + 1) % 4) as QuarterTurns,
    crop: { left: 1 - bottom, top: left, right: 1 - top, bottom: right },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A fractional crop as whole pixels inside an image of `size`.
 *
 * Integers because the native croppers take integers (Android's `createBitmap`
 * truncates, and throws on a rectangle that pokes past the bitmap). Clamped so
 * the rectangle is always at least one pixel and always inside the image, even
 * when the fractions came from a preview that rounded differently.
 */
export function cropToPixels(rect: NormalizedRect, size: PixelSize): PixelCrop {
  const width = Math.max(1, Math.floor(size.width));
  const height = Math.max(1, Math.floor(size.height));
  const originX = clamp(Math.round(rect.left * width), 0, width - 1);
  const originY = clamp(Math.round(rect.top * height), 0, height - 1);
  const rightPx = clamp(Math.round(rect.right * width), originX + 1, width);
  const bottomPx = clamp(Math.round(rect.bottom * height), originY + 1, height);
  return { originX, originY, width: rightPx - originX, height: bottomPx - originY };
}

/**
 * The picker's original, as the compressor oriented it.
 *
 * Taken from the compressed base's ASPECT plus the asset's LONG SIDE, not from
 * the asset's own width and height: on Android those can describe the sensor
 * rather than the picture (EXIF orientation ignored), and the base has already
 * had the orientation baked in, so its aspect is the true one.
 *
 * The short side is a lower bound, never an estimate that could overshoot. The
 * base's short side was ROUNDED from the original's, so it can be up to half a
 * base pixel long — `scale / 2` original pixels — and Android's cropper throws
 * on a rectangle that reaches even one pixel past the bitmap. Losing at most a
 * pixel row at the far edge costs nothing.
 *
 * Null when either size is not a real positive number; the caller then renders
 * from the base instead.
 */
export function orientedOriginalSize(base: PixelSize, originalLongSide: number): PixelSize | null {
  if (!(base.width > 0) || !(base.height > 0) || !(originalLongSide > 0)) return null;
  if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || !Number.isFinite(originalLongSide)) {
    return null;
  }
  const baseLong = Math.max(base.width, base.height);
  // An "original" smaller than its own compressed copy is not the original.
  if (originalLongSide < baseLong) return null;
  const longSide = Math.floor(originalLongSide);
  const scale = originalLongSide / baseLong;
  // The compressor left a photo this small alone, so the base IS the original's size.
  if (longSide === baseLong) return { width: base.width, height: base.height };
  const shortSide = Math.max(1, Math.floor(Math.min(base.width, base.height) * scale - scale / 2));
  return base.width >= base.height ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
}

/**
 * The largest original the final render reads, in pixels.
 *
 * Decoded memory, not the upload cap, sets this: a bitmap costs 4 bytes a
 * pixel, so a 25 MP original is about 100 MB, and a rotation holds a second
 * copy while it runs, next to an output of up to 67 MB at 4096 x 4096. A 48 MP
 * capture (8064 x 6048) would be about 195 MB a copy. 25 MP covers the 12 MP
 * and 24 MP captures phones take by default (5712 x 4284 is 24.5 MP).
 *
 * Above it the render reads the compressed base. At a 4096 px cap that base
 * still has half the original's width, not the quarter it had at 2048, so
 * rotating or loosely cropping a 48 MP photo uploads exactly what reading the
 * original would have. Only a crop tighter than half of each side comes out
 * softer.
 */
export const ORIGINAL_RENDER_MAX_PIXELS = 25_000_000;

/**
 * The original's oriented size when the final render will read it, or null when
 * it will read the base instead: the original's size is unknown, or decoding it
 * would cost more than `ORIGINAL_RENDER_MAX_PIXELS` allows.
 *
 * Shared by the render and the small-photo hint, so the hint predicts from the
 * file the render will actually read.
 */
export function renderableOriginalSize(base: PixelSize, originalLongSide: number): PixelSize | null {
  const original = orientedOriginalSize(base, originalLongSide);
  if (!original || original.width * original.height > ORIGINAL_RENDER_MAX_PIXELS) return null;
  return original;
}

/** One native operation, in the order it runs. */
export type WallPhotoRenderOp =
  | { type: 'rotate'; degrees: 90 | 180 | 270 }
  | { type: 'crop'; rect: PixelCrop }
  | { type: 'resize'; width: number }
  | { type: 'resize'; height: number };

export type WallPhotoRenderPlan = {
  ops: WallPhotoRenderOp[];
  /** What the render is expected to produce. The real size comes from the rendered image. */
  output: PixelSize;
};

/**
 * The operations that turn `sourceSize` into the edited upload, in one pass:
 * rotate, then crop, then shrink the long side to `maxDimension`.
 *
 * One pass from the source rather than a chain of saved files, so the pixels
 * are resampled once. The resize names ONE side — the longer — exactly as
 * `compressPickedImage` does, so the native resizer keeps the aspect itself.
 * The identity edit on a photo already small enough plans nothing at all.
 */
export function planWallPhotoRender(
  edit: WallPhotoEdit,
  sourceSize: PixelSize,
  maxDimension: number,
): WallPhotoRenderPlan {
  const ops: WallPhotoRenderOp[] = [];
  if (edit.quarterTurns !== 0) {
    ops.push({ type: 'rotate', degrees: (edit.quarterTurns * 90) as 90 | 180 | 270 });
  }
  const rotated = rotatedSize(
    { width: Math.max(1, Math.floor(sourceSize.width)), height: Math.max(1, Math.floor(sourceSize.height)) },
    edit.quarterTurns,
  );
  let current = rotated;
  if (!isFullRect(edit.crop)) {
    const rect = cropToPixels(edit.crop, rotated);
    ops.push({ type: 'crop', rect });
    current = { width: rect.width, height: rect.height };
  }
  const longest = Math.max(current.width, current.height);
  if (longest > maxDimension) {
    const scale = maxDimension / longest;
    if (current.width >= current.height) {
      ops.push({ type: 'resize', width: maxDimension });
      current = { width: maxDimension, height: Math.max(1, Math.round(current.height * scale)) };
    } else {
      ops.push({ type: 'resize', height: maxDimension });
      current = { width: Math.max(1, Math.round(current.width * scale)), height: maxDimension };
    }
  }
  return { ops, output: current };
}

/** Whether a photo of this size is small enough to warn about. */
export function isPhotoSmall(size: PixelSize, threshold = SMALL_PHOTO_LONG_SIDE): boolean {
  const longest = Math.max(size.width, size.height);
  return longest > 0 && longest < threshold;
}

/**
 * The smallest crop, as fractions of the rotated image's width and height.
 *
 * The larger of `MIN_CROP_FRACTION` and `MIN_CROP_PIXELS` on that side of the
 * BASE, capped at the whole side: a base narrower than 512 px cannot be cropped
 * across at all, which is right, because there is nothing to spare.
 */
export function minimumCropFractions(baseSize: PixelSize, turns: QuarterTurns): { width: number; height: number } {
  const rotated = rotatedSize(baseSize, turns);
  const along = (side: number) => (side > 0 ? Math.min(1, Math.max(MIN_CROP_FRACTION, MIN_CROP_PIXELS / side)) : 1);
  return { width: along(rotated.width), height: along(rotated.height) };
}

/**
 * A crop that keeps the minimum on both axes, grown about its own centre and
 * pulled back inside the image if growing pushed it out. Used when a crop from
 * before a turn lands on an axis with a different minimum.
 */
export function enforceMinimumCrop(rect: NormalizedRect, min: { width: number; height: number }): NormalizedRect {
  const grow = (start: number, end: number, minimum: number): [number, number] => {
    const size = end - start;
    if (size >= minimum) return [clamp(start, 0, 1), clamp(end, 0, 1)];
    const centre = (start + end) / 2;
    const half = minimum / 2;
    const low = clamp(centre - half, 0, 1 - minimum);
    return [low, low + minimum];
  };
  const [left, right] = grow(rect.left, rect.right, min.width);
  const [top, bottom] = grow(rect.top, rect.bottom, min.height);
  return { left, top, right, bottom };
}

/**
 * The output a plan predicts, for the small-photo hint before anything renders.
 * Planned from whichever file the render will read: the original when it is
 * small enough to decode, the base otherwise.
 */
export function predictedEditOutput(
  edit: WallPhotoEdit,
  base: PixelSize,
  originalLongSide: number,
  maxDimension: number,
): PixelSize {
  const source = renderableOriginalSize(base, originalLongSide) ?? base;
  return planWallPhotoRender(edit, source, maxDimension).output;
}
