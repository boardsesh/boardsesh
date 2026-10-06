/**
 * The generated wall looks: the photo flattened into the canonical frame
 * ("Wall only"), and only the holds on a transparent background ("Holds only").
 *
 * The STORED photo is never warped (`homography.ts`): holds are mapped through
 * the inverse at draw time. These looks are DERIVED images, made once per
 * version by the backend's `spray-wall-art` job and stored beside the photo.
 * The pixel maths lives here, dependency-free, so the job and any client
 * preview agree on the frame, the mask and the stretch gate.
 *
 * Both are drawn in the CANONICAL frame, the frame hold coordinates already
 * live in, so a renderer drawing art places holds with no homography at all.
 * The art is the canonical frame scaled by `canonicalArtSize(...).scale`.
 *
 * The recipe (dilate, feather, cap) is from the October 2026 spike's
 * `render.py`. Bump `ART_RECIPE` whenever any number here changes what a
 * rendered image looks like. The recipe is part of every art key and every
 * stored art row: after a bump the backend stops serving old-recipe art (it
 * reads as NONE, and clients draw the photo), and re-queues it the next time
 * `sprayWallArt` is read for the published version of a wall that chose a
 * generated look, or the owner chooses one again. Walls that chose the photo
 * are not regenerated. Old objects are never overwritten.
 */
import type { Homography, ReferenceSize } from './homography';
import { mapPoint } from './homography';

/** Bump whenever the rendered pixels would change. Part of every art object key. */
export const ART_RECIPE = 1;

/** Long-edge cap of a rendered art image, in pixels. */
export const ART_MAX_EDGE = 2048;

/** Each hold is grown by this fraction of its own radius, so its edge is not chewed off. */
export const ART_DILATE_FRACTION = 0.04;

/** Mask feather sigma, as a fraction of the median hold radius. */
export const ART_FEATHER_FRACTION = 0.06;

/**
 * Ceiling on the mask's feather sigma, in art pixels. The blur's cost grows
 * with sigma, and a hold radius is owner-supplied (up to 10,000 canonical px),
 * so an uncapped sigma of 600 kept a worker busy for minutes on one wall. Real
 * walls sit at about 1-3; 24 is a median hold of 400 art px, far past anything
 * a photo of a wall holds.
 */
export const ART_FEATHER_MAX_SIGMA = 24;

/**
 * Ceiling on one hold's dilation, in art pixels, for the same reason: it is a
 * stroke width in the mask, and 4% of an owner-supplied radius is unbounded.
 * 24 is the grow of a 600 px hold.
 */
export const ART_DILATE_MAX_PX = 24;

/** Radius the feather assumes for a wall with no holds yet. */
const ART_FALLBACK_RADIUS = 10;

/** Points in the circle drawn for a hold with no traced outline. */
export const ART_CIRCLE_POINTS = 32;

/**
 * The backgrounds an owner can pick for a wall (`render_settings.background`).
 * Missing means `photo`, which is what every wall drew before this shipped.
 */
export const SPRAY_WALL_BACKGROUNDS = ['photo', 'wall-crop', 'hold-cutouts'] as const;
export type SprayWallBackground = (typeof SPRAY_WALL_BACKGROUNDS)[number];

// A `hold-cutouts` image is transparent everywhere but the holds. Renderers draw
// it on the Aura field colour, `BOARD_FIELD_COLORS` in `@boardsesh/board-look`
// (#FFFFFF light, #181225 dark), so a wall of cutouts reads like an LED board.

/** One hold as the art needs it: canonical-frame centre and radius, optional ring in radius units. */
export type ArtHold = {
  cx: number;
  cy: number;
  r: number;
  outline?: readonly number[] | null;
};

/** One filled shape of the hold mask, in ART pixels, plus how far to grow it. */
export type ArtMaskRing = {
  /** Flat implicitly-closed ring `[x0, y0, x1, y1, ...]`. */
  points: number[];
  /** Dilation in art pixels. A stroke of twice this, round-joined, around the fill. */
  grow: number;
};

export type ArtSize = { width: number; height: number; scale: number };

/**
 * The pixel size art is rendered at: the canonical frame, scaled down so its
 * long edge is at most `maxEdge`. Never scaled up.
 */
export function canonicalArtSize(frame: ReferenceSize, maxEdge: number = ART_MAX_EDGE): ArtSize {
  const longEdge = Math.max(frame.width, frame.height);
  const scale = longEdge > 0 ? Math.min(1, maxEdge / longEdge) : 1;
  return {
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
    scale,
  };
}

function circleRing(cx: number, cy: number, r: number): number[] {
  const points: number[] = [];
  for (let index = 0; index < ART_CIRCLE_POINTS; index++) {
    const angle = (2 * Math.PI * index) / ART_CIRCLE_POINTS;
    points.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
  }
  return points;
}

/**
 * The filled shapes of the hold mask, in art pixels.
 *
 * A hold's outline is a flat ring in units of its radius around its centre
 * (the `spray_wall_holds.outline` contract). A hold with no outline, or one
 * shorter than three points or carrying a non-finite number, draws a
 * 32-point circle instead, the same fallback the renderer uses. Each ring's
 * grow is at least 1 and at most `ART_DILATE_MAX_PX`.
 */
export function holdMaskRings(holds: readonly ArtHold[], scale: number): ArtMaskRing[] {
  const rings: ArtMaskRing[] = [];
  for (const hold of holds) {
    if (![hold.cx, hold.cy, hold.r].every(Number.isFinite) || hold.r <= 0) continue;
    const cx = hold.cx * scale;
    const cy = hold.cy * scale;
    const r = hold.r * scale;
    const outline = hold.outline;
    const usable = outline != null && outline.length >= 6 && outline.every(Number.isFinite);
    const points = usable
      ? outline
          .slice(0, outline.length - (outline.length % 2))
          .map((value, index) => (index % 2 === 0 ? cx : cy) + value * r)
      : circleRing(cx, cy, r);
    rings.push({ points, grow: Math.min(ART_DILATE_MAX_PX, Math.max(1, Math.round(r * ART_DILATE_FRACTION))) });
  }
  return rings;
}

/**
 * The mask's Gaussian feather sigma, in art pixels: 6% of the median hold
 * radius, at least 1 and at most `ART_FEATHER_MAX_SIGMA`.
 */
export function artFeather(radii: readonly number[], scale: number): number {
  const finite = radii.filter((radius) => Number.isFinite(radius) && radius > 0).sort((a, b) => a - b);
  let median = ART_FALLBACK_RADIUS;
  if (finite.length > 0) {
    const middle = Math.floor(finite.length / 2);
    median = finite.length % 2 === 1 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
  }
  return Math.min(ART_FEATHER_MAX_SIGMA, Math.max(1, median * scale * ART_FEATHER_FRACTION));
}

/**
 * Warp a photo into the canonical frame by inverse mapping with bilinear
 * sampling.
 *
 * `src` is `sw` x `sh` interleaved `channels` bytes per pixel (sharp's raw
 * output). Each destination pixel's centre is taken back to canonical
 * coordinates (divide by `scale`), through `canonicalToPhoto` into photo
 * pixels, and sampled there. A destination pixel whose source falls outside
 * the photo is 0 in every channel.
 */
export function warpBilinear(
  src: Uint8Array,
  sw: number,
  sh: number,
  channels: number,
  canonicalToPhoto: Homography,
  dw: number,
  dh: number,
  scale: number,
): Uint8Array {
  if (src.length < sw * sh * channels) throw new Error('warpBilinear: source is shorter than sw x sh x channels');
  const out = new Uint8Array(dw * dh * channels);
  const maxX = sw - 1;
  const maxY = sh - 1;
  for (let dy = 0; dy < dh; dy++) {
    const canonicalY = (dy + 0.5) / scale;
    for (let dx = 0; dx < dw; dx++) {
      const [photoX, photoY] = mapPoint(canonicalToPhoto, (dx + 0.5) / scale, canonicalY);
      // Pixel centres sit at +0.5, so the sample grid is shifted back by half.
      const x = photoX - 0.5;
      const y = photoY - 0.5;
      if (!(x >= -0.5 && y >= -0.5 && x <= maxX + 0.5 && y <= maxY + 0.5)) continue;
      const clampedX = Math.min(Math.max(x, 0), maxX);
      const clampedY = Math.min(Math.max(y, 0), maxY);
      const x0 = Math.floor(clampedX);
      const y0 = Math.floor(clampedY);
      const x1 = Math.min(x0 + 1, maxX);
      const y1 = Math.min(y0 + 1, maxY);
      const fx = clampedX - x0;
      const fy = clampedY - y0;
      const topLeft = (y0 * sw + x0) * channels;
      const topRight = (y0 * sw + x1) * channels;
      const bottomLeft = (y1 * sw + x0) * channels;
      const bottomRight = (y1 * sw + x1) * channels;
      const target = (dy * dw + dx) * channels;
      for (let channel = 0; channel < channels; channel++) {
        const top = src[topLeft + channel] * (1 - fx) + src[topRight + channel] * fx;
        const bottom = src[bottomLeft + channel] * (1 - fx) + src[bottomRight + channel] * fx;
        out[target + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}
