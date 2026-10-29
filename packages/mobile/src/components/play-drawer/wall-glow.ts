import { relativeLuminance } from '@boardsesh/board-constants/readable-text-color';

// The lit wall button's glow (#7000, look F1b): every lit hold of the climb,
// turned a quarter clockwise and squashed into the pill as a soft blob of its
// role colour, under a frost, inside a plain hairline border (Marco: a simple
// border with the complex fill). Pure, so the maths is table-tested
// and the view (`WallGlow.tsx`) only draws what this returns.
//
// The numbers come from the reference mocks (scratchpad glow-spike r3.sh,
// bokeh2.sh): blob disc radius 0.6 x the median nearest-neighbour distance
// after compression, clamped 6..14 pt; a 16 pt blur at 0.9 x 2.2; an 8% white
// frost and 6% grain on #0E0D12; the label zone faded by the smallest step that
// clears 4.5:1.

/** A lit hold in board coordinates, in the colour the player draws its role. */
export type GlowHold = { x: number; y: number; color: string };

/** One blob in pill coordinates: its centre, the gradient's radius, its colour and its peak alpha. */
export type WallGlowBlob = { x: number; y: number; r: number; color: string; peak: number };

export type PillSize = { w: number; h: number };

/** The glow's blending, per platform and scheme. */
export type WallGlowBlend = 'screen' | 'multiply' | 'normal';

/** At most this many blobs, so the view stays a handful of Views. */
export const MAX_WALL_GLOW_BLOBS = 15;
const MIN_DISC_RADIUS = 6;
const MAX_DISC_RADIUS = 14;
const BLUR = 16;
/** The mocks' dots at 0.9, blurred, then x2.2. */
/** How strong the frost reads; tuned on the simulator with Marco (#7000). */
export const WALL_GLOW_STRENGTH = 1.6;
const GAIN = 0.9 * 2.2 * WALL_GLOW_STRENGTH;
const MIN_PEAK = 0.15 * WALL_GLOW_STRENGTH;
const MAX_PEAK = Math.min(0.95, 0.6 * WALL_GLOW_STRENGTH);
/** The fade steps the mocks tried, smallest first. */
export const LABEL_FADE_STEPS = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9] as const;
export const MIN_LABEL_CONTRAST = 4.5;
export const FROST_ALPHA = 0.08;
export const GRAIN_ALPHA = 0.06;

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Evenly spaced picks, left to right, so a long climb keeps its spread. */
function thin<T extends { x: number }>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const sorted = [...items].sort((first, second) => first.x - second.x);
  const picks: T[] = [];
  for (let index = 0; index < max; index += 1) {
    const pick = sorted[Math.round((index * (sorted.length - 1)) / (max - 1))];
    if (pick) picks.push(pick);
  }
  return picks;
}

/**
 * Every lit hold, mapped into the pill with the board turned a quarter
 * clockwise, so the climb reads start to finish left to right and fills the
 * long pill:
 *
 * - the board's bottom (the start holds) is the pill's left end, its top (the
 *   finish) the right end: the board's height fits the pill's width;
 * - the board's left edge is the pill's top, its right edge the bottom, so a
 *   climb up the left of the board glows along the pill's top edge;
 * - the board's width takes the same scale where it fits the pill's height
 *   (centred), and is squashed into it only as much as it has to be.
 *
 * Circles stay round. A hold off the board is clamped to its edge; the pill
 * clips what spills past it. Empty with no holds or no room, which the view
 * reads as "use the flat amber".
 */
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
  if (holds.length === 0 || boardWidth <= 0 || boardHeight <= 0 || pill.w <= 0 || pill.h <= 0) return [];
  const scale = pill.w / boardHeight;
  const acrossFits = boardWidth * scale <= pill.h;
  const offset = acrossFits ? (pill.h - boardWidth * scale) / 2 : 0;
  const mapped = holds.map((hold) => {
    const across = clamp(hold.x, 0, boardWidth);
    const up = boardHeight - clamp(hold.y, 0, boardHeight);
    return {
      x: up * scale,
      y: acrossFits ? offset + across * scale : (across / boardWidth) * pill.h,
      color: hold.color,
    };
  });
  const placed = thin(mapped, MAX_WALL_GLOW_BLOBS);
  const nearest = placed.map((hold, index) => {
    let best = Infinity;
    placed.forEach((other, otherIndex) => {
      if (otherIndex !== index) best = Math.min(best, Math.hypot(hold.x - other.x, hold.y - other.y));
    });
    return best;
  });
  // One hold has no neighbour: it gets the widest disc.
  const disc = clamp(placed.length > 1 ? 0.6 * median(nearest) : MAX_DISC_RADIUS, MIN_DISC_RADIUS, MAX_DISC_RADIUS);
  // A disc of radius `disc` blurred by `BLUR`: its peak is the share of the
  // Gaussian inside the disc.
  const peak = clamp(GAIN * (1 - Math.exp(-(disc * disc) / (2 * BLUR * BLUR))), MIN_PEAK, MAX_PEAK);
  const r = disc + 2 * BLUR;
  return placed.map((hold) => ({ x: hold.x, y: hold.y, r, color: hold.color, peak }));
}

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.replace(/./g, (digit) => digit + digit) : clean.slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function toHex([red, green, blue]: Rgb): string {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`.toUpperCase();
}

function rgba(hex: string, alpha: number): string {
  const [red, green, blue] = toRgb(hex);
  return `rgba(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)}, ${Number(alpha.toFixed(3))})`;
}

/** The blob's radial falloff: a blurred disc, peak at the centre, gone at `r`. */
const FALLOFF: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.3, 0.8],
  [0.55, 0.4],
  [0.8, 0.12],
  [1, 0],
];

/** A blob's CSS gradient, with its alpha scaled by `scale` (lower where the glow can't screen). */
export function blobGradient(blob: Pick<WallGlowBlob, 'color' | 'peak'>, scale = 1): string {
  const alpha = clamp(blob.peak * scale, 0, 1);
  const stops = FALLOFF.map(([at, share]) => `${rgba(blob.color, alpha * share)} ${Math.round(at * 100)}%`);
  return `radial-gradient(circle closest-side, ${stops.join(', ')})`;
}

/** A blob's alpha at a distance, matching `blobGradient`. */
function blobAlphaAt(blob: WallGlowBlob, distance: number, scale: number): number {
  const t = distance / blob.r;
  if (t >= 1) return 0;
  for (let index = 1; index < FALLOFF.length; index += 1) {
    const [at, share] = FALLOFF[index] ?? [1, 0];
    const [prevAt, prevShare] = FALLOFF[index - 1] ?? [0, 1];
    if (t <= at) return blob.peak * scale * (prevShare + ((t - prevAt) / (at - prevAt)) * (share - prevShare));
  }
  return 0;
}

export type WallGlowSurface = { base: string; label: string; frost: boolean; border: string };

/** What one pixel of the pill ends up as, in sRGB, drawn as the view draws it. */
export function wallGlowPixel(
  point: { x: number; y: number },
  blobs: readonly WallGlowBlob[],
  {
    surface,
    blend,
    opacityScale = 1,
    fade = 0,
  }: { surface: WallGlowSurface; blend: WallGlowBlend; opacityScale?: number; fade?: number },
): string {
  const base = toRgb(surface.base);
  const value: Rgb = [...base];
  for (const blob of blobs) {
    const alpha = blobAlphaAt(blob, Math.hypot(point.x - blob.x, point.y - blob.y), opacityScale);
    if (alpha <= 0) continue;
    const colour = toRgb(blob.color);
    for (let channel = 0; channel < 3; channel += 1) {
      const dst = value[channel] ?? 0;
      const src = colour[channel] ?? 0;
      const blended = blend === 'screen' ? 1 - (1 - dst) * (1 - src) : blend === 'multiply' ? dst * src : src;
      value[channel] = dst * (1 - alpha) + blended * alpha;
    }
  }
  for (let channel = 0; channel < 3; channel += 1) {
    // The label zone's fade: the base drawn over the glow.
    let channelValue = (value[channel] ?? 0) * (1 - fade) + (base[channel] ?? 0) * fade;
    // The frost (dark scheme only), then the grain at its worst: towards the
    // label's opposite, so the check never flatters.
    if (surface.frost) channelValue = channelValue * (1 - FROST_ALPHA) + FROST_ALPHA;
    const grainTowards = surface.frost ? 1 : 0;
    channelValue = channelValue * (1 - GRAIN_ALPHA) + grainTowards * GRAIN_ALPHA;
    value[channel] = channelValue;
  }
  return toHex(value);
}

function contrast(first: string, second: string): number {
  const firstLum = relativeLuminance(first) ?? 0;
  const secondLum = relativeLuminance(second) ?? 0;
  const [light, dark] = firstLum > secondLum ? [firstLum, secondLum] : [secondLum, firstLum];
  return (light + 0.05) / (dark + 0.05);
}

/** The label's zone: the middle of the pill, where the label sits between the bulb and the face. */
function labelZonePoints(pill: PillSize): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let column = 0; column <= 8; column += 1) {
    for (const dy of [-6, 0, 6]) points.push({ x: pill.w * (0.2 + (0.6 * column) / 8), y: pill.h / 2 + dy });
  }
  return points;
}

/** The worst label contrast over the label zone, for a fade. */
export function wallGlowLabelContrast(
  blobs: readonly WallGlowBlob[],
  pill: PillSize,
  options: { surface: WallGlowSurface; blend: WallGlowBlend; opacityScale?: number; fade?: number },
): number {
  let worst = Infinity;
  for (const point of labelZonePoints(pill)) {
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
  options: { surface: WallGlowSurface; blend: WallGlowBlend; opacityScale?: number },
): number {
  for (const fade of LABEL_FADE_STEPS) {
    if (wallGlowLabelContrast(blobs, pill, { ...options, fade }) >= MIN_LABEL_CONTRAST) return fade;
  }
  return 1;
}
