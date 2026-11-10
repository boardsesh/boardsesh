import sharp from 'sharp';

/**
 * The share-card blocks the climb card never draws: the avatar and monogram, the
 * JOIN pill, the recap's send dots and the profile's grade bars.
 *
 * Kept out of `og-family.ts` on purpose. That file is in `OPAQUE_RENDER_INPUTS`
 * because the climb card is drawn through it, so every edit there moves
 * `BOARD_RENDER_VERSION` and turns over every climb card and `/render/board` URL
 * at the edge. These blocks cannot change a climb card's pixels:
 * `buildOgClimbCardContent` never asks for one, and `og-card-text.test.ts` fails
 * if it starts to. If the climb card ever draws one of these, add this file to
 * `OPAQUE_RENDER_INPUTS`.
 */

export const PILL_HEIGHT = 44;
export const PILL_PADDING_X = 18;
export const PILL_DOT_SIZE = 12;
export const PILL_GAP = 10;

export const AVATAR_SIZE = 80;
export const AVATAR_GAP = 18;
const AVATAR_RING_WIDTH = 3;

/** Chart bars live in the lower column, above the wordmark's row and clear of the text. */
export const BARS_TOP = 486;
const BARS_BOTTOM = 556;
export const BARS_CLEARANCE = 16;
export const BARS_MIN_COUNT = 3;
const BAR_MAX_WIDTH = 40;
const BAR_GAP = 6;
const BAR_ZERO_HEIGHT = 4;
const BAR_ZERO_COLOR = '#2A2438';

/** Under this many dots they can afford to be big; over it they run one line. */
export const DOTS_LARGE_UP_TO = 10;
export const DOT_LARGE_SIZE = 40;
export const DOT_LARGE_GAP = 10;
export const DOT_SMALL_SIZE = 26;
export const DOT_SMALL_GAP = 8;
const DOT_RING_WIDTH = 5;
export const DOT_LABEL_PT = 20;
export const DOT_LABEL_GAP = 12;

/** The JOIN pill's outline and dot; its text is typeset with the rest of the stack. */
export function renderPillBackground(color: string, width: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PILL_HEIGHT}">` +
      `<rect x="1" y="1" width="${width - 2}" height="${PILL_HEIGHT - 2}" rx="${PILL_HEIGHT / 2 - 1}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-opacity="0.75" stroke-width="2"/>` +
      `<circle cx="${PILL_PADDING_X + PILL_DOT_SIZE / 2}" cy="${PILL_HEIGHT / 2}" r="${PILL_DOT_SIZE / 2}" fill="${color}"/>` +
      `</svg>`,
  );
}

/** A circular image, ringed, as one layer. The caller has already decoded and sized `png`. */
export async function renderAvatarImage(png: Buffer): Promise<Buffer> {
  const radius = AVATAR_SIZE / 2;
  const circle = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${radius}" cy="${radius}" r="${radius}" fill="#fff"/></svg>`,
  );
  const ring = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${radius}" cy="${radius}" r="${radius - AVATAR_RING_WIDTH / 2}" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="${AVATAR_RING_WIDTH}"/></svg>`,
  );
  const clipped = await sharp(png)
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
    .ensureAlpha()
    .composite([{ input: circle, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp(clipped)
    .composite([{ input: ring }])
    .png()
    .toBuffer();
}

export function renderMonogramDisc(color: string): Buffer {
  const radius = AVATAR_SIZE / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${radius}" cy="${radius}" r="${radius - AVATAR_RING_WIDTH / 2}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-opacity="0.6" stroke-width="${AVATAR_RING_WIDTH}"/></svg>`,
  );
}

/** The dots as one SVG, plus how many it drew: the rest are carried by the `+N` label. */
export function renderDotsSvg(
  dots: readonly { color: string; filled: boolean }[],
  count: number,
  size: number,
  gap: number,
): { svg: Buffer; width: number; height: number } {
  const step = size + gap;
  const width = Math.max(size, count * step - gap);
  const circles = dots
    .slice(0, count)
    .map((dot, index) => {
      const cx = index * step + size / 2;
      const cy = size / 2;
      return dot.filled
        ? `<circle cx="${cx}" cy="${cy}" r="${size / 2}" fill="${dot.color}"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${(size - DOT_RING_WIDTH) / 2}" fill="none" stroke="${dot.color}" stroke-width="${DOT_RING_WIDTH}"/>`;
    })
    .join('');
  return {
    svg: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${size}">${circles}</svg>`),
    width,
    height: size,
  };
}

/**
 * Bars as one SVG, scaled to the card's tallest. Bars with no count keep a flat
 * tick, so the x-axis stays a continuous scale from easiest to hardest.
 */
export function renderBarsSvg(
  bars: readonly { color: string; value: number }[],
  maxWidth: number,
): { svg: Buffer; width: number; height: number } {
  const height = BARS_BOTTOM - BARS_TOP;
  const tallest = Math.max(1, ...bars.map((bar) => bar.value));
  const barWidth = Math.min(BAR_MAX_WIDTH, Math.floor((maxWidth - BAR_GAP * (bars.length - 1)) / bars.length));
  const width = bars.length * barWidth + BAR_GAP * (bars.length - 1);
  const rects = bars
    .map((bar, index) => {
      const barHeight =
        bar.value > 0 ? Math.max(BAR_ZERO_HEIGHT, Math.round((bar.value / tallest) * height)) : BAR_ZERO_HEIGHT;
      const color = bar.value > 0 ? bar.color : BAR_ZERO_COLOR;
      return `<rect x="${index * (barWidth + BAR_GAP)}" y="${height - barHeight}" width="${barWidth}" height="${barHeight}" rx="2" fill="${color}"/>`;
    })
    .join('');
  return {
    svg: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`),
    width,
    height,
  };
}
