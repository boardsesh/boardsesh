import sharp from 'sharp';
import { FONT_GRADE_COLORS } from '@boardsesh/board-constants/grade-colors';
import { createOgFrameBuffer } from './background';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';
import { OG_JPEG_OPTIONS } from './pipeline';
import { escapePangoMarkup } from './validation';
import type { OutputFormat } from './types';

/**
 * The share-card family: one layout contract the playlist, join and later card
 * surfaces render through, so every link pasted into a chat reads like the climb
 * card and survives a square crop at 110px. See docs/og-climb.md.
 *
 * The surface supplies an art slot and a stack of text; the ground, the scrim,
 * the column and the wordmark are fixed here. Deliberately NOT in
 * `OPAQUE_RENDER_INPUTS`: climb card URLs are `immutable` for a year and must not
 * move until the climb card itself joins this grid.
 */

/** Canvas ground. Same colour the Aura veil washes toward on a dark field. */
export const OG_FAMILY_GROUND = '#181225';

/** A search engine crops the card to this square from the centre. The hero stays inside it. */
export const OG_FAMILY_CROP_LEFT = 285;
export const OG_FAMILY_CROP_RIGHT = 915;

/** Rows are stacked downward from here and must not pass the floor. */
const COLUMN_TOP = 40;
const COLUMN_FLOOR = 552;
const COLUMN_RIGHT = OG_IMAGE_WIDTH - 24;

/** Where the wordmark sits on every family card, whichever slot it uses. */
export const OG_FAMILY_WORDMARK_LEFT = 590;
export const OG_FAMILY_WORDMARK_TOP = 574;

const BOARD_TOP_INSET = 14;
const ART_HEIGHT = OG_IMAGE_HEIGHT - BOARD_TOP_INSET * 2;

/** The art slots. `none` draws no art and gives the text the width instead. */
export type OgFamilySlot = 'full' | 'narrow' | 'none';

type SlotGeometry = {
  /** Horizontal limits of the art on the canvas, or null for a card with no art. */
  art: { left: number; right: number } | null;
  columnLeft: number;
};

const SLOTS: Record<OgFamilySlot, SlotGeometry> = {
  full: { art: { left: 16, right: 560 }, columnLeft: 590 },
  narrow: { art: { left: 0, right: 290 }, columnLeft: 322 },
  none: { art: null, columnLeft: 310 },
};

/** The hero's horizontal limits for a slot: from the column's left edge to the crop edge. */
export function ogFamilyHeroBounds(slot: OgFamilySlot): { left: number; right: number } {
  return { left: SLOTS[slot].columnLeft, right: OG_FAMILY_CROP_RIGHT };
}

/** Left edge of a slot's text column. */
export function ogFamilyColumnLeft(slot: OgFamilySlot): number {
  return SLOTS[slot].columnLeft;
}

/** The art limits for a slot, or null when the slot draws no art. */
export function ogFamilyArtBounds(slot: OgFamilySlot): { left: number; right: number } | null {
  return SLOTS[slot].art;
}

/**
 * The box a board is fitted into for a slot, for `buildRenderConfig`'s `ogBox`.
 *
 * `narrow` only cares about height: the board is drawn at full card height and a
 * 290px slice of it is taken, so the width has to be big enough not to bind.
 */
export function ogFamilyBoardBox(slot: Exclude<OgFamilySlot, 'none'>): { width: number; height: number } {
  if (slot === 'narrow') return { width: OG_IMAGE_WIDTH, height: ART_HEIGHT };
  const art = SLOTS.full.art!;
  return { width: art.right - art.left, height: ART_HEIGHT };
}

export type OgFamilyBoardPlacement = {
  /** Where on the canvas the visible board starts. */
  canvasLeft: number;
  canvasTop: number;
  /** Where in the board-sized plane the visible part starts. */
  sourceLeft: number;
  sourceTop: number;
  visibleWidth: number;
  visibleHeight: number;
};

/**
 * Where a rendered board of this size lands, and the part of it that shows.
 *
 * `full` right-aligns the board against the column (the climb card's rule: it
 * pulls a portrait board into the crop) and never draws past the art slot.
 * `narrow` takes a 290px slice centred on the lit holds, clamped to the board, so
 * a climb that lives on one side of the wall is not cropped out of its own card.
 *
 * @param litCentroidX Centroid of the lit holds in board-pixel coordinates; the
 * board's centre is used when nothing is lit.
 */
export function placeOgFamilyBoard(
  slot: Exclude<OgFamilySlot, 'none'>,
  boardWidth: number,
  boardHeight: number,
  litCentroidX?: number,
): OgFamilyBoardPlacement {
  const art = SLOTS[slot].art!;
  const slotWidth = art.right - art.left;
  const visibleWidth = Math.min(boardWidth, slotWidth);
  const visibleHeight = Math.min(boardHeight, ART_HEIGHT);
  const canvasTop = Math.max(0, BOARD_TOP_INSET + Math.round((ART_HEIGHT - boardHeight) / 2));

  if (slot === 'full') {
    return {
      canvasLeft: Math.max(art.left, art.right - boardWidth),
      canvasTop,
      sourceLeft: boardWidth > slotWidth ? boardWidth - slotWidth : 0,
      sourceTop: 0,
      visibleWidth,
      visibleHeight,
    };
  }

  const centroid = litCentroidX ?? boardWidth / 2;
  const sourceLeft = Math.min(Math.max(0, Math.round(centroid - visibleWidth / 2)), boardWidth - visibleWidth);
  return {
    canvasLeft: art.left + Math.round((slotWidth - visibleWidth) / 2),
    canvasTop,
    sourceLeft,
    sourceTop: 0,
    visibleWidth,
    visibleHeight,
  };
}

// --- colour ---------------------------------------------------------------

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function relativeLuminance([red, green, blue]: Rgb): number {
  const linear = (channel: number) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function rgbToHsl([red, green, blue]: Rgb): [number, number, number] {
  const scaled = [red, green, blue].map((channel) => channel / 255);
  const max = Math.max(...scaled);
  const min = Math.min(...scaled);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const [r, g, b] = scaled;
  const sector = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [sector / 6, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]: [number, number, number]): Rgb {
  const channel = (toneOffset: number) => {
    const tone = (hue + toneOffset + 1) % 1;
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    if (tone < 1 / 6) return p + (q - p) * 6 * tone;
    if (tone < 1 / 2) return q;
    if (tone < 2 / 3) return p + (q - p) * (2 / 3 - tone) * 6;
    return p;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)].map((value) => Math.round(value * 255)) as Rgb;
}

/** The contrast the lift aims for against the family ground. */
const GRADE_MIN_CONTRAST = 4.8;
const GRADE_MIN_SATURATION = 0.78;
const GRADE_MAX_LIGHTNESS = 0.92;

/**
 * Lift a grade colour so it reads on the family ground, keeping its hue.
 *
 * V8 and up run to near-black purples (`#38006B`) that vanish on a dark field.
 * Raising lightness (and holding saturation up) keeps a V10 reading as purple
 * instead of turning it white. One lift, shared by every surface, so a grade is
 * the same colour wherever it appears.
 */
export function liftGradeColorForCard(hex: string): string {
  const ground = hexToRgb(OG_FAMILY_GROUND);
  let rgb = hexToRgb(hex);
  if (contrastRatio(rgb, ground) >= GRADE_MIN_CONTRAST) return hex;

  const [hue, originalSaturation, originalLightness] = rgbToHsl(rgb);
  const saturation = Math.max(originalSaturation, GRADE_MIN_SATURATION);
  let lightness = originalLightness;
  for (let step = 0; step < 80 && contrastRatio(rgb, ground) < GRADE_MIN_CONTRAST; step++) {
    lightness = Math.min(GRADE_MAX_LIGHTNESS, lightness + 0.012);
    rgb = hslToRgb([hue, saturation, lightness]);
  }
  return rgbToHex(rgb);
}

const FALLBACK_GRADE_COLOR = '#F8FAFC';

/** A Font grade's card colour (`7a` -> lifted `FONT_GRADE_COLORS['7a']`). */
export function ogFamilyGradeColor(fontGrade: string): string {
  const color = FONT_GRADE_COLORS[fontGrade.toLowerCase()];
  return color ? liftGradeColorForCard(color) : FALLBACK_GRADE_COLOR;
}

// --- the text stack -------------------------------------------------------

export const OG_FAMILY_WHITE = '#F8FAFC';
export const OG_FAMILY_MUTED = '#94A3B8';
export const OG_FAMILY_JOIN_GREEN = '#3DDC84';
const WORDMARK_COLOR = '#8791A3';

/** A run of one colour. Hero rows and supporting rows are both a list of these. */
export type OgFamilyTextRun = { text: string; color: string };

export type OgFamilyHero = {
  runs: readonly OgFamilyTextRun[];
  /** Largest point size to try. Measured fit decides the real one. */
  maxPt: number;
  /**
   * `false` keeps the hero on one line and shrinks it to fit: a grade is never
   * wrapped or cut. `true` wraps and, as a last resort, truncates: names run long.
   */
  wrap: boolean;
};

export type OgFamilyRow = {
  runs: readonly OgFamilyTextRun[];
  sizePt: number;
  weight: number;
  /** Row is truncated with an ellipsis beyond this many lines. Unset means one row's worth. */
  maxLines?: number;
  gapBelow?: number;
};

export type OgFamilyPill = { text: string; color: string };

export type OgFamilyCardContent = {
  slot: OgFamilySlot;
  fontFamily?: string;
  pill?: OgFamilyPill;
  hero: OgFamilyHero;
  rows: readonly OgFamilyRow[];
};

/** Renders at 96 dpi throughout, so a point is 1.33 pixels. */
const DPI = 96;
const LINE_HEIGHT_FACTOR = 1.4;
const MIN_HERO_PT = 20;
const HERO_MAX_HEIGHT = 290;
const WRAP_HERO_STEP_PT = 4;
const TRUNCATION_ATTEMPTS = 6;
const PILL_HEIGHT = 44;
const PILL_PADDING_X = 18;
const PILL_DOT_SIZE = 12;
const PILL_GAP = 10;

const CJK_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

type TextLayer = { input: Buffer; left: number; top: number };
type TextRaster = { buffer: Buffer; width: number; height: number };

// Temporary copy of og-card.ts's renderText so this module can ship without
// touching a file in OPAQUE_RENDER_INPUTS. Deleted when the climb card moves
// onto this grid and the two text paths become one.
async function renderRaster(
  markup: string,
  options: { fontFamily?: string; width?: number; align?: 'left' | 'right' },
): Promise<TextRaster> {
  const { data, info } = await sharp({
    text: {
      text: markup,
      ...(options.fontFamily ? { font: options.fontFamily } : {}),
      ...(options.width ? { width: options.width, wrap: 'word-char' as const } : {}),
      ...(options.align ? { align: options.align } : {}),
      rgba: true,
      dpi: DPI,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

function isRightToLeft(value: string): boolean {
  return /^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u.test(value);
}

/** Pango line-height factor for a wrapping hero; Noto's default leaves big gaps at display sizes. */
const HERO_LINE_HEIGHT = 0.9;

function runsMarkup(runs: readonly OgFamilyTextRun[], pt: number, weight: number, lineHeight?: number): string {
  const lineHeightAttr = lineHeight ? ` line_height="${lineHeight}"` : '';
  return runs
    .map(
      (run) =>
        `<span size="${pt}pt" weight="${weight}" foreground="${run.color}"${lineHeightAttr}>${escapePangoMarkup(run.text)}</span>`,
    )
    .join('');
}

/**
 * Shave the transparent side-bearing off a hero raster.
 *
 * At display sizes a glyph's bearing is ~10px, so a hero laid out at the column's
 * left edge reads as indented next to the smaller rows. Trimming the ink edge the
 * text is anchored to brings them into one line.
 */
async function trimHeroInk(raster: TextRaster, side: 'left' | 'right'): Promise<TextRaster> {
  const { data, info } = await sharp(raster.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const columnIsEmpty = (column: number) => {
    for (let row = 0; row < height; row++) {
      if (data[(row * width + column) * channels + (channels - 1)] > 8) return false;
    }
    return true;
  };
  let inset = 0;
  if (side === 'left') {
    while (inset < width - 1 && columnIsEmpty(inset)) inset++;
  } else {
    while (inset < width - 1 && columnIsEmpty(width - 1 - inset)) inset++;
  }
  if (inset === 0) return raster;
  const left = side === 'left' ? inset : 0;
  const buffer = await sharp(raster.buffer)
    .extract({ left, top: 0, width: width - inset, height })
    .png()
    .toBuffer();
  return { buffer, width: width - inset, height };
}

function truncateRuns(runs: readonly OgFamilyTextRun[]): OgFamilyTextRun[] {
  const last = runs[runs.length - 1];
  const codePoints = Array.from(last.text.replace(/…$/u, ''));
  const keep = Math.max(1, Math.floor(codePoints.length * 0.85));
  return [...runs.slice(0, -1), { ...last, text: `${codePoints.slice(0, keep).join('').trimEnd()}…` }];
}

/**
 * Point-size ceiling so the widest single word in a wrapping hero fits the box.
 * Without this Pango breaks a long word mid-character instead of the size coming
 * down. CJK has no spaces to break on and wraps per character, so it is skipped.
 */
async function ptCapForWidestToken(
  tokens: readonly string[],
  maxPt: number,
  maxWidth: number,
  fontFamily: string | undefined,
): Promise<number> {
  const measurable = tokens.filter((token) => token.length > 0 && !CJK_WORD.test(token));
  if (measurable.length === 0) return maxPt;
  const measured = await Promise.all(
    measurable.map((token) =>
      renderRaster(runsMarkup([{ text: token, color: OG_FAMILY_WHITE }], maxPt, 800), { fontFamily }).then(
        (raster) => raster.width,
      ),
    ),
  );
  const widest = Math.max(...measured);
  // Glyph ink rounds in a few pixels against the layout width, so leave a margin.
  const usable = maxWidth * 0.96;
  return widest <= usable ? maxPt : Math.max(MIN_HERO_PT, Math.floor((maxPt * usable) / widest));
}

/** Below this, a hero name stops reading as a hero and may as well wrap. */
const MIN_SINGLE_LINE_NAME_PT = 42;

/**
 * The hero, at the largest size that fits its box.
 *
 * Measure-then-retry rather than counting characters: the hero may be in any
 * script, and the only honest measurement is the one Pango makes.
 */
async function fitHero(
  hero: OgFamilyHero,
  box: { width: number },
  fontFamily: string | undefined,
  align: 'left' | 'right',
): Promise<TextRaster> {
  let runs = hero.runs;
  const lineHeight = hero.wrap ? HERO_LINE_HEIGHT : undefined;
  let ptCap = hero.maxPt;
  if (hero.wrap) {
    const text = runs.map((run) => run.text).join('');
    // First choice: the largest size where each explicit line stays on one line,
    // so "Join / Huy Dang" is two lines rather than a fat three.
    const singleLinePt = await ptCapForWidestToken(text.split('\n'), hero.maxPt, box.width, fontFamily);
    if (singleLinePt >= MIN_SINGLE_LINE_NAME_PT) {
      const raster = await renderRaster(runsMarkup(runs, singleLinePt, 800, lineHeight), { fontFamily, align });
      if (raster.width <= box.width && raster.height <= HERO_MAX_HEIGHT) return raster;
    }
    ptCap = await ptCapForWidestToken(text.split(/\s+/), hero.maxPt, box.width, fontFamily);
  }

  for (let attempt = 0; attempt < TRUNCATION_ATTEMPTS; attempt++) {
    let pt = ptCap;
    let raster: TextRaster | undefined;
    for (;;) {
      const candidate = await renderRaster(runsMarkup(runs, pt, 800, lineHeight), {
        fontFamily,
        ...(hero.wrap ? { width: box.width, align } : {}),
      });
      raster = candidate;
      if (candidate.width <= box.width && candidate.height <= HERO_MAX_HEIGHT) return candidate;
      if (pt <= MIN_HERO_PT) break;
      pt = hero.wrap
        ? Math.max(MIN_HERO_PT, pt - WRAP_HERO_STEP_PT)
        : Math.max(MIN_HERO_PT, Math.min(pt - 2, Math.floor((pt * box.width) / candidate.width)));
    }
    if (!hero.wrap) return raster;
    runs = truncateRuns(runs);
  }
  return renderRaster(runsMarkup(runs, MIN_HERO_PT, 800, lineHeight), { fontFamily, width: box.width, align });
}

async function renderRow(
  row: OgFamilyRow,
  width: number,
  fontFamily: string | undefined,
  align: 'left' | 'right',
): Promise<TextRaster> {
  const maxHeight = Math.ceil((row.maxLines ?? 1) * row.sizePt * (DPI / 72) * LINE_HEIGHT_FACTOR);
  let runs = row.runs;
  for (let attempt = 0; attempt < TRUNCATION_ATTEMPTS; attempt++) {
    const raster = await renderRaster(runsMarkup(runs, row.sizePt, row.weight), { fontFamily, width, align });
    if (raster.height <= maxHeight) return raster;
    runs = truncateRuns(runs);
  }
  return renderRaster(runsMarkup(runs, row.sizePt, row.weight), { fontFamily, width, align });
}

async function renderPillLayers(pill: OgFamilyPill, fontFamily: string | undefined, left: number, top: number) {
  const text = await renderRaster(
    `<span size="18pt" weight="800" letter_spacing="1400" foreground="${pill.color}">${escapePangoMarkup(pill.text)}</span>`,
    { fontFamily },
  );
  const width = PILL_PADDING_X * 2 + PILL_DOT_SIZE + PILL_GAP + text.width;
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PILL_HEIGHT}">` +
      `<rect x="1" y="1" width="${width - 2}" height="${PILL_HEIGHT - 2}" rx="${PILL_HEIGHT / 2 - 1}" fill="${pill.color}" fill-opacity="0.14" stroke="${pill.color}" stroke-opacity="0.75" stroke-width="2"/>` +
      `<circle cx="${PILL_PADDING_X + PILL_DOT_SIZE / 2}" cy="${PILL_HEIGHT / 2}" r="${PILL_DOT_SIZE / 2}" fill="${pill.color}"/>` +
      `</svg>`,
  );
  return {
    height: PILL_HEIGHT,
    layers: [
      { input: background, left, top },
      {
        input: text.buffer,
        left: left + PILL_PADDING_X + PILL_DOT_SIZE + PILL_GAP,
        top: top + Math.round((PILL_HEIGHT - text.height) / 2),
      },
    ],
  };
}

export type OgFamilyHeroRect = { left: number; top: number; width: number; height: number };

/**
 * Lay out the family's text stack for one card and return its composite layers.
 *
 * Only the hero has to survive the crop, so only the hero is bounded by it;
 * supporting rows use the rest of the column. A row that would run past the
 * floor is dropped rather than overlapped.
 */
export async function renderOgFamilyTextLayers(
  content: OgFamilyCardContent,
): Promise<{ layers: TextLayer[]; hero: OgFamilyHeroRect }> {
  const { slot, fontFamily, pill, hero, rows } = content;
  const bounds = ogFamilyHeroBounds(slot);
  const heroWidth = bounds.right - bounds.left;
  const columnWidth = COLUMN_RIGHT - bounds.left;

  const heroText = hero.runs.map((run) => run.text).join('');
  const heroRtl = isRightToLeft(heroText);
  const heroAlign = heroRtl ? 'right' : 'left';
  const heroRaster = await trimHeroInk(
    await fitHero(hero, { width: heroWidth }, fontFamily, heroAlign),
    heroRtl ? 'right' : 'left',
  );

  const stacked: { input: Buffer; left: number; offset: number }[] = [];
  let cursor = 0;

  let pillBlock: { height: number; layers: TextLayer[] } | null = null;
  if (pill) {
    // Placed at offset 0 and re-based onto the final block top below.
    pillBlock = await renderPillLayers(pill, fontFamily, bounds.left, 0);
    cursor += pillBlock.height + 14;
  }

  const heroLeft = heroRtl ? bounds.right - heroRaster.width : bounds.left;
  stacked.push({ input: heroRaster.buffer, left: heroLeft, offset: cursor });
  const heroOffset = cursor;
  cursor += heroRaster.height + (hero.wrap ? 16 : 4);

  for (const row of rows) {
    const rowText = row.runs.map((run) => run.text).join('');
    const rowRtl = isRightToLeft(rowText);
    const raster = await renderRow(row, rowRtl ? heroWidth : columnWidth, fontFamily, rowRtl ? 'right' : 'left');
    if (cursor + raster.height > COLUMN_FLOOR - COLUMN_TOP) break;
    stacked.push({
      input: raster.buffer,
      left: rowRtl ? bounds.right - raster.width : bounds.left,
      offset: cursor,
    });
    cursor += raster.height + (row.gapBelow ?? 10);
  }

  const blockHeight = cursor;
  const blockTop = Math.max(COLUMN_TOP, COLUMN_TOP + Math.round((COLUMN_FLOOR - COLUMN_TOP - blockHeight) / 2));

  const layers: TextLayer[] = [];
  if (pillBlock) {
    for (const layer of pillBlock.layers) layers.push({ ...layer, top: layer.top + blockTop });
  }
  for (const row of stacked) layers.push({ input: row.input, left: row.left, top: blockTop + row.offset });

  const wordmark = await renderRaster(
    `<span size="16pt" weight="700" letter_spacing="1800" foreground="${WORDMARK_COLOR}">BOARDSESH</span>`,
    { fontFamily },
  );
  layers.push({ input: wordmark.buffer, left: OG_FAMILY_WORDMARK_LEFT, top: OG_FAMILY_WORDMARK_TOP });

  return {
    layers: layers.filter((layer) => layer.top >= 0 && layer.top < OG_IMAGE_HEIGHT),
    hero: {
      left: heroLeft,
      top: blockTop + heroOffset,
      width: heroRaster.width,
      height: heroRaster.height,
    },
  };
}

// --- composition ----------------------------------------------------------

const SCRIM_FEATHER_WIDTH = 240;
const SCRIM_COLUMN_OPACITY = 0.92;
const SCRIM_FIELD_OPACITY = 0.82;
const SCRIM_GROUND_TINT_OPACITY = 0.4;

/**
 * Lays the family ground over the bokeh: a tint across the whole card, then a
 * feathered ramp into the near-solid column so the text never competes with it.
 * A card with no art takes the dark field across its full width instead.
 */
export function buildOgFamilyScrim(slot: OgFamilySlot): Buffer {
  const width = OG_IMAGE_WIDTH;
  const height = OG_IMAGE_HEIGHT;
  const tint = `<rect width="${width}" height="${height}" fill="${OG_FAMILY_GROUND}" fill-opacity="${SCRIM_GROUND_TINT_OPACITY}"/>`;
  const art = SLOTS[slot].art;
  if (!art) {
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tint}<rect width="${width}" height="${height}" fill="${OG_FAMILY_GROUND}" fill-opacity="${SCRIM_FIELD_OPACITY}"/></svg>`,
    );
  }
  const columnLeft = SLOTS[slot].columnLeft;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tint}<defs><linearGradient id="scrim"><stop offset="0" stop-color="${OG_FAMILY_GROUND}" stop-opacity="0"/><stop offset="1" stop-color="${OG_FAMILY_GROUND}" stop-opacity="${SCRIM_COLUMN_OPACITY}"/></linearGradient></defs><rect x="${columnLeft - SCRIM_FEATHER_WIDTH}" width="${SCRIM_FEATHER_WIDTH}" height="${height}" fill="url(#scrim)"/><rect x="${columnLeft}" width="${width - columnLeft}" height="${height}" fill="${OG_FAMILY_GROUND}" fill-opacity="${SCRIM_COLUMN_OPACITY}"/></svg>`,
  );
}

const PNG_OPTIONS: sharp.PngOptions = { compressionLevel: 9, adaptiveFiltering: true };
const WEBP_OPTIONS: sharp.WebpOptions = { quality: 80 };

export type OgFamilyArtLayers = {
  /** Board-sized folded board photo (raw RGBA), or null when no photo resolved. */
  plane: Buffer | null;
  /** Board-sized overlay (raw RGBA). */
  overlay: Buffer;
  width: number;
  height: number;
  placement: OgFamilyBoardPlacement;
  /** Draw the rounded frame around the board. Off for the bleeding `narrow` slice. */
  frame: boolean;
};

/** Cut the visible rectangle out of a board-sized raw plane when it is not the whole plane. */
async function visiblePortion(
  raw: Buffer,
  width: number,
  height: number,
  placement: OgFamilyBoardPlacement,
): Promise<{ input: Buffer; raw: { width: number; height: number; channels: 4 } }> {
  const { sourceLeft, sourceTop, visibleWidth, visibleHeight } = placement;
  if (sourceLeft === 0 && sourceTop === 0 && visibleWidth === width && visibleHeight === height) {
    return { input: raw, raw: { width, height, channels: 4 } };
  }
  const input = await sharp(raw, { raw: { width, height, channels: 4 } })
    .extract({ left: sourceLeft, top: sourceTop, width: visibleWidth, height: visibleHeight })
    .raw()
    .toBuffer();
  return { input, raw: { width: visibleWidth, height: visibleHeight, channels: 4 } };
}

/**
 * Build the final card: bokeh, family scrim, the art (if any), the text.
 *
 * Text layers go last so they are always on top, and the art slot's right edge
 * is left of every text column, so the art can never sit under the words.
 */
export async function composeOgFamilyCard(params: {
  /** Raw RGBA frosted backdrop, already at canvas size. */
  background: Buffer;
  slot: OgFamilySlot;
  art: OgFamilyArtLayers | null;
  textLayers: readonly sharp.OverlayOptions[];
  format: OutputFormat;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const { background, slot, art, textLayers, format } = params;

  const layers: sharp.OverlayOptions[] = [{ input: buildOgFamilyScrim(slot) }];
  if (art) {
    const { placement } = art;
    if (art.frame) {
      layers.push({
        input: createOgFrameBuffer({
          left: placement.canvasLeft,
          top: placement.canvasTop,
          width: placement.visibleWidth,
          height: placement.visibleHeight,
        }),
      });
    }
    if (art.plane) {
      const plane = await visiblePortion(art.plane, art.width, art.height, placement);
      layers.push({ ...plane, left: placement.canvasLeft, top: placement.canvasTop, blend: 'over' });
    }
    const overlay = await visiblePortion(art.overlay, art.width, art.height, placement);
    layers.push({ ...overlay, left: placement.canvasLeft, top: placement.canvasTop, blend: 'over' });
  }
  layers.push(...textLayers);

  const composited = sharp(background, {
    raw: { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, channels: 4 },
  }).composite(layers);

  if (format === 'png') return { buffer: await composited.png(PNG_OPTIONS).toBuffer(), contentType: 'image/png' };
  if (format === 'webp') return { buffer: await composited.webp(WEBP_OPTIONS).toBuffer(), contentType: 'image/webp' };
  return { buffer: await composited.jpeg(OG_JPEG_OPTIONS).toBuffer(), contentType: 'image/jpeg' };
}
