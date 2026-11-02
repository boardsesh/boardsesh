/** Renderer-independent frosted bokeh, shared by native controls and server share cards. */
export type BokehPoint = { x: number; y: number; color: string };
export type BokehBlob = BokehPoint & { r: number; peak: number };
export type BokehSize = { w: number; h: number };
export type BokehBlend = 'screen' | 'multiply' | 'normal';
export type BokehSurface = { base: string; frost: boolean };

export const BOKEH_DARK_SURFACE = { base: '#0E0D12', frost: true } as const;
export const BOKEH_LIGHT_SURFACE = { base: '#F6F3FB', frost: false } as const;

/** Keep the drawing bounded even for long circuits. */
export const MAX_BOKEH_BLOBS = 15;
export const BOKEH_STRENGTH = 1.6;
export const FROST_ALPHA = 0.08;
export const GRAIN_ALPHA = 0.06;
const MIN_DISC_RADIUS = 6;
const MAX_DISC_RADIUS = 14;
const BLUR = 16;
const GAIN = 0.9 * 2.2 * BOKEH_STRENGTH;
const MIN_PEAK = 0.15 * BOKEH_STRENGTH;
const MAX_PEAK = Math.min(0.95, 0.6 * BOKEH_STRENGTH);

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
 * Map coloured source points into a target surface. The source's horizontal
 * extent fills the target width; its vertical extent keeps that scale where
 * it fits, and compresses only when necessary. Clockwise rotation makes a
 * bottom-to-top climb read left to right. Points outside the source clamp to
 * its edges; consumers clip the blobs to their own surface shape.
 *
 * effectScale changes the blur and radius together, preserving the native
 * control's falloff and intensity on larger canvases.
 */
export function buildBokehBlobs({
  points,
  source,
  target,
  rotation = 'none',
  effectScale = 1,
}: {
  points: readonly BokehPoint[];
  source: BokehSize;
  target: BokehSize;
  rotation?: 'none' | 'clockwise';
  effectScale?: number;
}): BokehBlob[] {
  if (
    points.length === 0 ||
    ![source.w, source.h, target.w, target.h, effectScale].every(
      (dimension) => Number.isFinite(dimension) && dimension > 0,
    )
  )
    return [];
  const rotated = rotation === 'clockwise';
  const sourceAlong = rotated ? source.h : source.w;
  const sourceAcross = rotated ? source.w : source.h;
  const positionScale = target.w / sourceAlong;
  const acrossFits = sourceAcross * positionScale <= target.h;
  const offset = acrossFits ? (target.h - sourceAcross * positionScale) / 2 : 0;
  const mapped = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => {
      const sourceX = clamp(point.x, 0, source.w);
      const sourceY = clamp(point.y, 0, source.h);
      const along = rotated ? source.h - sourceY : sourceX;
      const across = rotated ? sourceX : sourceY;
      return {
        x: along * positionScale,
        y: acrossFits ? offset + across * positionScale : (across / sourceAcross) * target.h,
        color: point.color,
      };
    });
  const placed = thin(mapped, MAX_BOKEH_BLOBS);
  const nearest = placed.map((point, index) => {
    let best = Infinity;
    placed.forEach((other, otherIndex) => {
      if (otherIndex !== index) best = Math.min(best, Math.hypot(point.x - other.x, point.y - other.y));
    });
    return best;
  });
  const minDisc = MIN_DISC_RADIUS * effectScale;
  const maxDisc = MAX_DISC_RADIUS * effectScale;
  const blur = BLUR * effectScale;
  const disc = clamp(placed.length > 1 ? 0.6 * median(nearest) : maxDisc, minDisc, maxDisc);
  const peak = clamp(GAIN * (1 - Math.exp(-(disc * disc) / (2 * blur * blur))), MIN_PEAK, MAX_PEAK);
  const radius = disc + 2 * blur;
  return placed.map((point) => ({ ...point, r: radius, peak }));
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
export const BOKEH_FALLOFF: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.3, 0.8],
  [0.55, 0.4],
  [0.8, 0.12],
  [1, 0],
];

/** A blob's CSS gradient, with its alpha scaled by `scale` (lower where the glow can't screen). */
export function blobGradient(blob: Pick<BokehBlob, 'color' | 'peak'>, scale = 1): string {
  const alpha = clamp(blob.peak * scale, 0, 1);
  const stops = BOKEH_FALLOFF.map(([at, share]) => `${rgba(blob.color, alpha * share)} ${Math.round(at * 100)}%`);
  return `radial-gradient(circle closest-side, ${stops.join(', ')})`;
}

/** A blob's alpha at a distance, matching `blobGradient`. */
function blobAlphaAt(blob: BokehBlob, distance: number, scale: number): number {
  const t = distance / blob.r;
  if (t >= 1) return 0;
  for (let index = 1; index < BOKEH_FALLOFF.length; index += 1) {
    const [at, share] = BOKEH_FALLOFF[index] ?? [1, 0];
    const [prevAt, prevShare] = BOKEH_FALLOFF[index - 1] ?? [0, 1];
    if (t <= at) return blob.peak * scale * (prevShare + ((t - prevAt) / (at - prevAt)) * (share - prevShare));
  }
  return 0;
}

/** What one pixel of the surface ends up as, in sRGB, drawn as the view draws it. */
export function bokehPixel(
  point: { x: number; y: number },
  blobs: readonly BokehBlob[],
  {
    surface,
    blend,
    opacityScale = 1,
    fade = 0,
  }: { surface: BokehSurface; blend: BokehBlend; opacityScale?: number; fade?: number },
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
