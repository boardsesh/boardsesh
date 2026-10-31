import { relativeLuminance } from '@boardsesh/board-constants/readable-text-color';
import {
  buildBokehBlobs,
  bokehPixel,
  type BokehBlob,
  type BokehBlend,
  type BokehPoint,
  type BokehSize,
  type BokehSurface,
} from '@boardsesh/frosted-bokeh';

export {
  blobGradient,
  FROST_ALPHA,
  GRAIN_ALPHA,
  MAX_BOKEH_BLOBS as MAX_WALL_GLOW_BLOBS,
  BOKEH_STRENGTH as WALL_GLOW_STRENGTH,
} from '@boardsesh/frosted-bokeh';

export type GlowHold = BokehPoint;
export type WallGlowBlob = BokehBlob;
export type PillSize = BokehSize;
export type WallGlowBlend = BokehBlend;
export type WallGlowSurface = BokehSurface & { label: string; border: string };
export const wallGlowPixel = bokehPixel;

/** The board button keeps its clockwise composition and native-point sizing. */
export function wallGlowBlobs({
  holds,
  boardWidth,
  boardHeight,
  pill,
}: {
  holds: readonly GlowHold[];
  boardWidth: number;
  boardHeight: number;
  pill: PillSize;
}): WallGlowBlob[] {
  return buildBokehBlobs({
    points: holds,
    source: { w: boardWidth, h: boardHeight },
    target: pill,
    rotation: 'clockwise',
  });
}

/** The label policy belongs to the button, independently of the background. */
export const LABEL_FADE_STEPS = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9] as const;
export const MIN_LABEL_CONTRAST = 4.5;
export type WallGlowReadableZone = 'center' | 'full';

function contrast(first: string, second: string): number {
  const firstLum = relativeLuminance(first) ?? 0;
  const secondLum = relativeLuminance(second) ?? 0;
  const [light, dark] = firstLum > secondLum ? [firstLum, secondLum] : [secondLum, firstLum];
  return (light + 0.05) / (dark + 0.05);
}

/** The player's centred label, or the header's two lines spanning the whole pill. */
function labelZonePoints(pill: PillSize, readableZone: WallGlowReadableZone): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  if (readableZone === 'full') {
    // At most four points between checks, including the very edges and both
    // vertical extremes. The header can put a long name or grade in any of them.
    const columns = Math.max(1, Math.ceil(pill.w / 4));
    const rows = Math.max(1, Math.ceil(pill.h / 4));
    for (let column = 0; column <= columns; column += 1) {
      for (let row = 0; row <= rows; row += 1) {
        points.push({ x: (pill.w * column) / columns, y: (pill.h * row) / rows });
      }
    }
    return points;
  }
  for (let column = 0; column <= 8; column += 1) {
    for (const dy of [-6, 0, 6]) points.push({ x: pill.w * (0.2 + (0.6 * column) / 8), y: pill.h / 2 + dy });
  }
  return points;
}

/** The worst label contrast over the label zone, for a fade. */
export function wallGlowLabelContrast(
  blobs: readonly WallGlowBlob[],
  pill: PillSize,
  options: {
    surface: WallGlowSurface;
    blend: WallGlowBlend;
    opacityScale?: number;
    fade?: number;
    readableZone?: WallGlowReadableZone;
  },
): number {
  const readableZone = options.readableZone ?? 'center';
  const points = labelZonePoints(pill, readableZone);
  if (readableZone === 'full') {
    // Include exact peaks between grid samples, clamped to the visible pill for
    // a blob centred outside it. A bright hold can sit behind either text line.
    for (const blob of blobs) {
      points.push({ x: Math.max(0, Math.min(pill.w, blob.x)), y: Math.max(0, Math.min(pill.h, blob.y)) });
    }
  }
  let worst = Infinity;
  for (const point of points) {
    worst = Math.min(worst, contrast(options.surface.label, wallGlowPixel(point, blobs, options)));
  }
  return worst;
}

/**
 * The smallest label-zone fade that keeps the label at 4.5:1 or better, over
 * the brightest pixel the glow can put under it (the mocks' "autofix"). The
 * text shadow only adds to that.
 */
export function wallGlowLabelFade(
  blobs: readonly WallGlowBlob[],
  pill: PillSize,
  options: {
    surface: WallGlowSurface;
    blend: WallGlowBlend;
    opacityScale?: number;
    readableZone?: WallGlowReadableZone;
  },
): number {
  for (const fade of LABEL_FADE_STEPS) {
    if (wallGlowLabelContrast(blobs, pill, { ...options, fade }) >= MIN_LABEL_CONTRAST) return fade;
  }
  return 1;
}
