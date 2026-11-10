import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FONT_GRADE_COLORS } from '@boardsesh/board-constants/grade-colors';
import { createOgFrameBuffer } from './background';
import {
  OG_CARD_ART_LEFT,
  OG_CARD_ART_RIGHT,
  OG_CARD_BOARD_BOX,
  OG_CARD_COLUMN_LEFT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  placeOgBoard,
} from './headers';
import type { OutputFormat } from './types';
import {
  AVATAR_GAP,
  AVATAR_SIZE,
  BARS_CLEARANCE,
  BARS_MIN_COUNT,
  BARS_TOP,
  DOT_LABEL_GAP,
  DOT_LABEL_PT,
  DOT_LARGE_GAP,
  DOT_LARGE_SIZE,
  DOT_SMALL_GAP,
  DOT_SMALL_SIZE,
  DOTS_LARGE_UP_TO,
  PILL_DOT_SIZE,
  PILL_GAP,
  PILL_HEIGHT,
  PILL_PADDING_X,
  renderAvatarImage,
  renderBarsSvg,
  renderDotsSvg,
  renderMonogramDisc,
  renderPillBackground,
} from './og-family-blocks';
import { escapePangoMarkup } from './validation';

/**
 * The share-card family: one layout contract the playlist, join and later card
 * surfaces render through, so every link pasted into a chat reads like the climb
 * card and survives a square crop at 110px. See docs/og-climb.md.
 *
 * The surface supplies an art slot and a stack of text; the ground, the scrim,
 * the column and the wordmark are fixed here. The climb card draws through it
 * too (`og-card.ts`), so this file is in `OPAQUE_RENDER_INPUTS`: an edit here
 * moves `BOARD_RENDER_VERSION` and with it every climb card and `/render/board`
 * URL. The blocks only other cards draw (avatar, pill, dots, bars) are drawn in
 * `og-family-blocks.ts`, which is not hashed.
 */

/**
 * Share-card JPEG encode: mozjpeg at quality 85 with full chroma so hold rings
 * stay crisp (~50–90KB at 1200×630).
 */
export const OG_JPEG_OPTIONS: sharp.JpegOptions = {
  quality: 85,
  chromaSubsampling: '4:4:4',
  mozjpeg: true,
};
const OG_PNG_OPTIONS: sharp.PngOptions = { compressionLevel: 9, adaptiveFiltering: true };
const OG_WEBP_OPTIONS: sharp.WebpOptions = { quality: 80 };

/**
 * Encode a finished card. JPEG is what every card is served as by default; PNG and
 * WebP exist because `/og/climb` has always honoured `format`, and it still must.
 */
export async function encodeOgCard(
  image: sharp.Sharp,
  format: OutputFormat = 'jpeg',
): Promise<{ buffer: Buffer; contentType: string }> {
  if (format === 'png') return { buffer: await image.png(OG_PNG_OPTIONS).toBuffer(), contentType: 'image/png' };
  if (format === 'webp') return { buffer: await image.webp(OG_WEBP_OPTIONS).toBuffer(), contentType: 'image/webp' };
  return { buffer: await image.jpeg(OG_JPEG_OPTIONS).toBuffer(), contentType: 'image/jpeg' };
}

/** Canvas ground. Same colour the Aura veil washes toward on a dark field. */
export const OG_FAMILY_GROUND = '#181225';

/** A search engine crops the card to this square from the centre. The hero stays inside it. */
export const OG_FAMILY_CROP_LEFT = 285;
export const OG_FAMILY_CROP_RIGHT = 915;

/** Rows are stacked downward from here and must not pass the floor. */
const COLUMN_TOP = 40;
const COLUMN_FLOOR = 552;
const COLUMN_RIGHT = OG_IMAGE_WIDTH - 24;

/**
 * Where the wordmark sits on every family card, whichever slot it uses: its right
 * edge is fixed at the bottom right, the one spot that clears the text on the
 * left-aligned column, the wide narrow-slot hero and the centred no-art card. The
 * app icon sits left of it, so the pair grows leftward from that fixed edge.
 */
export const OG_FAMILY_WORDMARK_RIGHT = 1160;
export const OG_FAMILY_WORDMARK_TOP = 574;

/**
 * The app icon beside the wordmark: a rounded square this many pixels wide, this
 * far left of the wordmark's first letter, centred on the letters' own height.
 */
export const OG_FAMILY_ICON_SIZE = 30;
export const OG_FAMILY_ICON_GAP = 10;
const ICON_CORNER_RADIUS = OG_FAMILY_ICON_SIZE * 0.22;

/**
 * `packages/web/app/icon.png` resized to `OG_FAMILY_ICON_SIZE` and committed beside
 * this package, so the backend image carries it with the package source and no
 * card resamples a 512px icon. It is in `OPAQUE_RENDER_INPUTS`: the climb card
 * draws it. Resolved from this file rather than the working directory so tests,
 * scripts and the container all find the same file.
 */
export const OG_FAMILY_ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '../assets/og-app-icon.png');

let iconSourcePath = OG_FAMILY_ICON_PATH;
let roundedIcon: Promise<Buffer> | undefined;

/**
 * Test seam: drop the decoded icon and read it from `iconPath` next time, so a
 * test can make the read fail and then put the real file back.
 */
export function resetOgFamilyIcon(iconPath: string = OG_FAMILY_ICON_PATH): void {
  iconSourcePath = iconPath;
  roundedIcon = undefined;
}

/** The icon with its corners cut, decoded once per process. A failed read is not remembered. */
function getRoundedIcon(): Promise<Buffer> {
  const size = OG_FAMILY_ICON_SIZE;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${ICON_CORNER_RADIUS}" fill="#fff"/></svg>`,
  );
  roundedIcon ??= sharp(iconSourcePath)
    .resize(size, size)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
    .catch((error: unknown) => {
      roundedIcon = undefined;
      throw error;
    });
  return roundedIcon;
}

/** Rows of a raster that carry ink, and its first inked column. */
async function measureInk(raster: Buffer): Promise<{ left: number; top: number; bottom: number }> {
  const { data, info } = await sharp(raster).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let left = width;
  let top = height;
  let bottom = -1;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (data[(row * width + column) * channels + (channels - 1)] <= 8) continue;
      left = Math.min(left, column);
      top = Math.min(top, row);
      bottom = row;
    }
  }
  return bottom < 0 ? { left: 0, top: 0, bottom: height - 1 } : { left, top, bottom };
}

const BOARD_TOP_INSET = OG_CARD_BOARD_BOX.top;
const ART_HEIGHT = OG_CARD_BOARD_BOX.height;

/** The art slots. `none` draws no art and gives the text the width instead. */
export type OgFamilySlot = 'full' | 'narrow' | 'none';

type SlotGeometry = {
  /** Horizontal limits of the art on the canvas, or null for a card with no art. */
  art: { left: number; right: number } | null;
  columnLeft: number;
};

const SLOTS: Record<OgFamilySlot, SlotGeometry> = {
  full: { art: { left: OG_CARD_ART_LEFT, right: OG_CARD_ART_RIGHT }, columnLeft: OG_CARD_COLUMN_LEFT },
  narrow: { art: { left: 0, right: 290 }, columnLeft: 322 },
  // No art: the text is centred across the whole crop rather than left-aligned on
  // an empty field, so `columnLeft` is the crop's own left edge.
  none: { art: null, columnLeft: OG_FAMILY_CROP_LEFT },
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
    // The climb card's own placement, so a family board and a climb board sit in
    // exactly the same spot.
    const placed = placeOgBoard(boardWidth, boardHeight);
    return {
      canvasLeft: placed.left,
      canvasTop: placed.top,
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
/** The line that names what a place has, above its name. */
export const OG_FAMILY_PLACE_ACCENT = '#6FE3EE';
const WORDMARK_COLOR = '#8791A3';

/**
 * A run of one colour. Hero rows and supporting rows are both a list of these.
 * `scale` draws the run smaller than its row (the unit in `1.1M sends`), on the
 * same baseline, so the number can carry the size that reads at 110px.
 */
export type OgFamilyTextRun = { text: string; color: string; scale?: number };

export type OgFamilyHero = {
  runs: readonly OgFamilyTextRun[];
  /** Largest point size to try. Measured fit decides the real one. */
  maxPt: number;
  /**
   * Smallest point size a wrapping hero may reach. Below it the hero truncates
   * instead, so a long name still reads as the hero and not as a supporting line.
   */
  minPt?: number;
  /**
   * `false` keeps the hero on one line and shrinks it to fit: a grade is never
   * wrapped or cut. `true` wraps and, as a last resort, truncates: names run long.
   */
  wrap: boolean;
  /**
   * Trim the raster to the glyphs' own height. A display-size line carries about
   * a third of its height as empty ascender and descender, which would float the
   * rows far from a big grade.
   */
  tight?: boolean;
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

/** Either a decoded avatar or a drawn initial. `digest` is what the byte cache keys on. */
export type OgFamilyAvatar =
  | { kind: 'image'; png: Buffer; digest: string }
  | { kind: 'monogram'; letter: string; color: string };

/** The name line above the hero, with an optional avatar or monogram beside it. */
export type OgFamilyIdentity = { name: string; avatar: OgFamilyAvatar | null; sizePt: number };

/** A chart bar. `value` is relative to the tallest bar on the same card. */
export type OgFamilyBar = { color: string; value: number };

/** One dot per send. `total` is the real count, which may exceed `dots.length`. */
export type OgFamilyDots = {
  dots: readonly { color: string; filled: boolean }[];
  total: number;
  /** Muted text drawn after the dots: `3 attempts`. */
  label?: string;
};

/** The credit on the right of a narrow card. Never part of the hero, so it may sit outside the crop. */
export type OgFamilyAside = { eyebrow: string; title: string; lines: readonly string[] };

export type OgFamilyCardContent = {
  slot: OgFamilySlot;
  fontFamily?: string;
  identity?: OgFamilyIdentity;
  pill?: OgFamilyPill;
  /** The line directly above the hero: what a place has, or what the card is. */
  eyebrow?: OgFamilyRow;
  hero: OgFamilyHero;
  rows: readonly OgFamilyRow[];
  dots?: OgFamilyDots;
  bars?: readonly OgFamilyBar[];
  aside?: OgFamilyAside;
  /** Colour for the frosted ground of a card with no art and so no lit holds to take it from. */
  fieldGlow?: { points: { x: number; y: number; color: string }[]; source: { w: number; h: number } };
};

/** Renders at 96 dpi throughout, so a point is 1.33 pixels. */
const DPI = 96;
const LINE_HEIGHT_FACTOR = 1.4;
const MIN_HERO_PT = 20;
const HERO_MAX_HEIGHT = 340;
const WRAP_HERO_STEP_PT = 4;
const TRUNCATION_ATTEMPTS = 6;
const ASIDE_LEFT = 930;
const ASIDE_TOP = 72;
const ASIDE_WIDTH = 230;

const LEFT_TO_RIGHT_MARK = '\u200E';
const CJK_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

type TextLayer = { input: Buffer; left: number; top: number };
type TextRaster = { buffer: Buffer; width: number; height: number };
type TextAlign = 'left' | 'right' | 'centre';

/** The one Pango text path every share card draws through. */
async function renderRaster(
  markup: string,
  options: { fontFamily?: string; width?: number; align?: TextAlign },
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
/** One line at that factor is about 1.25 em tall and two about 2.5, so this tells them apart. */
const MIN_MULTI_LINE_EMS = 1.8;

function runsMarkup(runs: readonly OgFamilyTextRun[], pt: number, weight: number, lineHeight?: number): string {
  const lineHeightAttr = lineHeight ? ` line_height="${lineHeight}"` : '';
  return runs
    .map(
      (run) =>
        `<span size="${Math.round(pt * (run.scale ?? 1))}pt" weight="${weight}" foreground="${run.color}"${lineHeightAttr}>${escapePangoMarkup(run.text)}</span>`,
    )
    .join('');
}

/**
 * Shave the transparent side-bearing off a hero raster.
 *
 * At display sizes a glyph's bearing is ~10px, so a hero laid out at the column's
 * left edge reads as indented next to the smaller rows. Trimming the edge the text
 * is anchored to brings them into one line.
 *
 * `hang` is how far the ink of the upper lines reaches past the lower ones: the hook
 * of a "J" over "Huy Dang". The stack aligns on the lower lines and lets that hook
 * sit left of them, the way a typesetter would, instead of indenting every line.
 */
async function trimHeroInk(
  raster: FittedHero,
  side: 'left' | 'right',
  multiLine: boolean,
  tight: boolean,
): Promise<FittedHero & { hang: number }> {
  const { data, info } = await sharp(raster.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const columnHasInk = (column: number, fromRow: number) => {
    for (let row = fromRow; row < height; row++) {
      if (data[(row * width + column) * channels + (channels - 1)] > 8) return true;
    }
    return false;
  };
  const columnAt = (inset: number) => (side === 'left' ? inset : width - 1 - inset);
  const firstInked = (fromRow: number) => {
    let inset = 0;
    while (inset < width - 1 && !columnHasInk(columnAt(inset), fromRow)) inset++;
    return inset;
  };
  const inset = firstInked(0);
  // One line has no lower lines to align on: its lower half is just the point of
  // a "V" or the stem of a "T". A wrapping hero that fitted on one line counts.
  const linesTall = height / ((raster.pt * DPI) / 72);
  const hang =
    side === 'left' && multiLine && linesTall >= MIN_MULTI_LINE_EMS ? firstInked(Math.floor(height / 2)) - inset : 0;

  let topInset = 0;
  let inkHeight = height;
  if (tight) {
    const rowHasInk = (row: number) => {
      for (let column = 0; column < width; column++) {
        if (data[(row * width + column) * channels + (channels - 1)] > 8) return true;
      }
      return false;
    };
    while (topInset < height - 1 && !rowHasInk(topInset)) topInset++;
    let lastInked = height - 1;
    while (lastInked > topInset && !rowHasInk(lastInked)) lastInked--;
    inkHeight = lastInked - topInset + 1;
  }

  if (inset === 0 && topInset === 0 && inkHeight === height) return { ...raster, hang };
  const buffer = await sharp(raster.buffer)
    .extract({ left: side === 'left' ? inset : 0, top: topInset, width: width - inset, height: inkHeight })
    .png()
    .toBuffer();
  return { ...raster, buffer, width: width - inset, height: inkHeight, hang };
}

/**
 * Give every line a left-to-right base direction.
 *
 * Pango infers each paragraph's direction from its first strong letter and flips
 * `align: left` for a right-to-left one, which pushes a Hebrew or Arabic name to
 * the far edge of its box. A left-to-right mark keeps it on the stack's edge; the
 * bidi algorithm still orders the name's own letters and words right to left.
 */
function withLeftToRightBase(runs: readonly OgFamilyTextRun[]): OgFamilyTextRun[] {
  return runs.map((run, index) => ({
    ...run,
    text: `${index === 0 ? LEFT_TO_RIGHT_MARK : ''}${run.text.replaceAll('\n', `\n${LEFT_TO_RIGHT_MARK}`)}`,
  }));
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
  minPt: number,
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
  return widest <= usable ? maxPt : Math.max(minPt, Math.floor((maxPt * usable) / widest));
}

/**
 * Keep each explicit line whole only while that costs little size. "Join / Huy
 * Dang" is cleaner on two lines; "Join / Daniel Comber-Todd" reads better wrapped
 * and big than on one small line.
 */
const SINGLE_LINE_MIN_SIZE_RATIO = 0.8;

type FittedHero = TextRaster & { pt: number };

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
  align: TextAlign,
): Promise<FittedHero> {
  return hero.wrap ? fitWrappingHero(hero, box, fontFamily, align) : fitOneLineHero(hero, box, fontFamily);
}

/** A grade: one line, shrunk to fit, never cut. */
async function fitOneLineHero(
  hero: OgFamilyHero,
  box: { width: number },
  fontFamily: string | undefined,
): Promise<FittedHero> {
  let pt = hero.maxPt;
  for (;;) {
    const raster = await renderRaster(runsMarkup(hero.runs, pt, 800), { fontFamily });
    if ((raster.width <= box.width && raster.height <= HERO_MAX_HEIGHT) || pt <= MIN_HERO_PT) return { ...raster, pt };
    pt = Math.max(MIN_HERO_PT, Math.min(pt - 2, Math.floor((pt * box.width) / raster.width)));
  }
}

/** A name: the largest size that fits, wrapping as needed, truncating only below the floor. */
async function fitWrappingHero(
  hero: OgFamilyHero,
  box: { width: number },
  fontFamily: string | undefined,
  align: TextAlign,
): Promise<FittedHero> {
  const minPt = hero.minPt ?? MIN_HERO_PT;
  const text = hero.runs.map((run) => run.text).join('');
  const singleLinePt = await ptCapForWidestToken(text.split('\n'), hero.maxPt, box.width, fontFamily, MIN_HERO_PT);
  // Pango also breaks after a hyphen, so a hyphenated name is sized by its parts.
  const wordCapPt = await ptCapForWidestToken(text.split(/[\s-]+/), hero.maxPt, box.width, fontFamily, minPt);

  const directed = (runs: readonly OgFamilyTextRun[]) => (align === 'left' ? withLeftToRightBase(runs) : runs);
  let runs = hero.runs;
  for (let attempt = 0; attempt < TRUNCATION_ATTEMPTS; attempt++) {
    for (let pt = wordCapPt; ; pt = Math.max(minPt, pt - WRAP_HERO_STEP_PT)) {
      const wrapped = await renderRaster(runsMarkup(directed(runs), pt, 800, HERO_LINE_HEIGHT), {
        fontFamily,
        width: box.width,
        align,
      });
      if (wrapped.width <= box.width && wrapped.height <= HERO_MAX_HEIGHT) {
        if (attempt === 0 && singleLinePt >= Math.max(minPt, pt * SINGLE_LINE_MIN_SIZE_RATIO)) {
          const singleLine = await renderRaster(runsMarkup(directed(runs), singleLinePt, 800, HERO_LINE_HEIGHT), {
            fontFamily,
            align,
          });
          if (singleLine.width <= box.width && singleLine.height <= HERO_MAX_HEIGHT) {
            return { ...singleLine, pt: singleLinePt };
          }
        }
        return { ...wrapped, pt };
      }
      if (pt <= minPt) break;
    }
    runs = truncateRuns(runs);
  }
  const raster = await renderRaster(runsMarkup(directed(runs), minPt, 800, HERO_LINE_HEIGHT), {
    fontFamily,
    width: box.width,
    align,
  });
  return { ...raster, pt: minPt };
}

async function renderRow(
  row: OgFamilyRow,
  width: number,
  fontFamily: string | undefined,
  align: TextAlign,
): Promise<TextRaster> {
  const maxHeight = Math.ceil((row.maxLines ?? 1) * row.sizePt * (DPI / 72) * LINE_HEIGHT_FACTOR);
  const directed = (runs: readonly OgFamilyTextRun[]) => (align === 'left' ? withLeftToRightBase(runs) : runs);
  let runs = row.runs;
  for (let attempt = 0; attempt < TRUNCATION_ATTEMPTS; attempt++) {
    const raster = await renderRaster(runsMarkup(directed(runs), row.sizePt, row.weight), { fontFamily, width, align });
    if (raster.height <= maxHeight) return raster;
    runs = truncateRuns(runs);
  }
  return renderRaster(runsMarkup(directed(runs), row.sizePt, row.weight), { fontFamily, width, align });
}

async function renderPill(pill: OgFamilyPill, fontFamily: string | undefined) {
  const text = await renderRaster(
    `<span size="18pt" weight="800" letter_spacing="1400" foreground="${pill.color}">${escapePangoMarkup(pill.text)}</span>`,
    { fontFamily },
  );
  const width = PILL_PADDING_X * 2 + PILL_DOT_SIZE + PILL_GAP + text.width;
  return { background: renderPillBackground(pill.color, width), text, width };
}

export type OgFamilyHeroRect = { left: number; top: number; width: number; height: number; pt: number };

/** Where the optional blocks landed, for the geometry tests. Absent when not drawn. */
export type OgFamilyBlockRects = {
  eyebrow?: { left: number; top: number; width: number; height: number };
  identity?: { left: number; top: number; width: number; height: number };
  dots?: { left: number; top: number; width: number; height: number };
  bars?: { left: number; top: number; width: number; height: number };
  aside?: { left: number; top: number; width: number; height: number };
};

/** The icon and wordmark together, for the geometry tests: nothing else may touch it. */
export type OgFamilyBrandRect = { left: number; top: number; width: number; height: number };

/**
 * Lay out the family's text stack for one card and return its composite layers.
 *
 * Only the hero has to survive the crop, so only the hero is bounded by it;
 * supporting rows use the rest of the column. A row that would run past the
 * floor is dropped rather than overlapped.
 */
export async function renderOgFamilyTextLayers(content: OgFamilyCardContent): Promise<{
  layers: TextLayer[];
  hero: OgFamilyHeroRect;
  blocks: OgFamilyBlockRects;
  brand: OgFamilyBrandRect;
  /** Why the app icon is missing from `layers`, or null when it was drawn. */
  iconError: string | null;
}> {
  const { slot, fontFamily, identity, pill, eyebrow, hero, rows, dots, bars, aside } = content;
  const bounds = ogFamilyHeroBounds(slot);
  const heroWidth = bounds.right - bounds.left;
  const columnWidth = COLUMN_RIGHT - bounds.left;

  // One direction for the whole stack, set by the hero. A right-to-left name
  // inside a left-aligned card stays on the column's edge and Pango still orders
  // its letters correctly, so the rows never start at two different places.
  const direction: TextAlign =
    slot === 'none' ? 'centre' : isRightToLeft(hero.runs.map((run) => run.text).join('')) ? 'right' : 'left';
  const anchor = (width: number) => {
    if (direction === 'left') return bounds.left;
    if (direction === 'right') return bounds.right - width;
    return Math.round((bounds.left + bounds.right - width) / 2);
  };
  // Only a left-aligned stack can use the rest of the column past the crop, and
  // never when an aside already claims that side of the card.
  const rowWidth = direction === 'left' && !aside ? columnWidth : heroWidth;

  const fitted = await fitHero(hero, { width: heroWidth }, fontFamily, direction);
  const heroRaster =
    direction === 'centre' ? { ...fitted, hang: 0 } : await trimHeroInk(fitted, direction, hero.wrap, !!hero.tight);

  const stacked: { input: Buffer; left: number; offset: number }[] = [];
  const blocks: OgFamilyBlockRects = {};
  const blockOffsets: { identity?: number; dots?: number; eyebrow?: number } = {};
  let cursor = 0;

  if (identity) {
    const avatarWidth = identity.avatar ? AVATAR_SIZE + AVATAR_GAP : 0;
    const name = await renderRow(
      {
        runs: [{ text: identity.name, color: OG_FAMILY_WHITE }],
        sizePt: identity.sizePt,
        weight: 700,
      },
      rowWidth - avatarWidth,
      fontFamily,
      direction,
    );
    const blockHeight = Math.max(identity.avatar ? AVATAR_SIZE : 0, name.height);
    const blockWidth = avatarWidth + name.width;
    const blockLeft = anchor(blockWidth);
    if (identity.avatar?.kind === 'image') {
      stacked.push({
        input: await renderAvatarImage(identity.avatar.png),
        left: blockLeft,
        offset: Math.round((blockHeight - AVATAR_SIZE) / 2),
      });
    } else if (identity.avatar?.kind === 'monogram') {
      const { letter, color } = identity.avatar;
      stacked.push({
        input: renderMonogramDisc(color),
        left: blockLeft,
        offset: Math.round((blockHeight - AVATAR_SIZE) / 2),
      });
      const glyph = await renderRaster(
        `<span size="30pt" weight="700" foreground="${color}">${escapePangoMarkup(letter)}</span>`,
        { fontFamily },
      );
      stacked.push({
        input: glyph.buffer,
        left: blockLeft + Math.round((AVATAR_SIZE - glyph.width) / 2),
        offset: Math.round((blockHeight - glyph.height) / 2),
      });
    }
    stacked.push({
      input: name.buffer,
      left: blockLeft + avatarWidth,
      offset: Math.round((blockHeight - name.height) / 2),
    });
    blocks.identity = { left: blockLeft, top: 0, width: blockWidth, height: blockHeight };
    blockOffsets.identity = 0;
    cursor += blockHeight + 14;
  }

  if (pill) {
    const { background, text, width } = await renderPill(pill, fontFamily);
    const left = anchor(width);
    stacked.push({ input: background, left, offset: cursor });
    stacked.push({
      input: text.buffer,
      left: left + PILL_PADDING_X + PILL_DOT_SIZE + PILL_GAP,
      offset: cursor + Math.round((PILL_HEIGHT - text.height) / 2),
    });
    cursor += PILL_HEIGHT + 14;
  }

  if (eyebrow) {
    const raster = await renderRow(eyebrow, rowWidth, fontFamily, direction);
    const left = anchor(raster.width);
    stacked.push({ input: raster.buffer, left, offset: cursor });
    blocks.eyebrow = { left, top: 0, width: raster.width, height: raster.height };
    blockOffsets.eyebrow = cursor;
    cursor += raster.height + (eyebrow.gapBelow ?? 6);
  }

  const heroLeft = anchor(heroRaster.width) - heroRaster.hang;
  stacked.push({ input: heroRaster.buffer, left: heroLeft, offset: cursor });
  const heroOffset = cursor;
  cursor += heroRaster.height + (hero.wrap ? 26 : hero.tight ? 18 : 4);

  for (const row of rows) {
    const raster = await renderRow(row, rowWidth, fontFamily, direction);
    if (cursor + raster.height > COLUMN_FLOOR - COLUMN_TOP) break;
    stacked.push({ input: raster.buffer, left: anchor(raster.width), offset: cursor });
    cursor += raster.height + (row.gapBelow ?? 10);
  }

  if (dots && dots.total > 0) {
    const large = dots.dots.length <= DOTS_LARGE_UP_TO && dots.total <= DOTS_LARGE_UP_TO;
    const size = large ? DOT_LARGE_SIZE : DOT_SMALL_SIZE;
    const gap = large ? DOT_LARGE_GAP : DOT_SMALL_GAP;
    const capacity = Math.floor((heroWidth + gap) / (size + gap));
    const measureLabel = (text: string) =>
      renderRaster(runsMarkup([{ text, color: OG_FAMILY_MUTED }], DOT_LABEL_PT, 600), { fontFamily });
    const overflowLabel = (drawn: number) => `+${(dots.total - drawn).toLocaleString('en-US')}`;
    let shown = Math.min(capacity, dots.dots.length);
    const labelText = dots.label ?? (dots.total > shown ? overflowLabel(shown) : null);
    let labelRaster: TextRaster | null = labelText ? await measureLabel(labelText) : null;
    // A `+N` chip takes room from the dots it stands for, so it has to count itself in.
    while (labelRaster && shown > 1 && shown * (size + gap) - gap + DOT_LABEL_GAP + labelRaster.width > heroWidth) {
      shown -= 1;
      if (!dots.label) labelRaster = await measureLabel(overflowLabel(shown));
    }
    const { svg, width, height } = renderDotsSvg(dots.dots, shown, size, gap);
    const fullWidth = width + (labelRaster ? DOT_LABEL_GAP + labelRaster.width : 0);
    if (cursor + height <= COLUMN_FLOOR - COLUMN_TOP) {
      cursor += 6;
      const left = anchor(fullWidth);
      stacked.push({ input: svg, left, offset: cursor });
      if (labelRaster) {
        stacked.push({
          input: labelRaster.buffer,
          left: left + width + DOT_LABEL_GAP,
          offset: cursor + Math.round((height - labelRaster.height) / 2),
        });
      }
      blocks.dots = { left, top: 0, width: fullWidth, height };
      blockOffsets.dots = cursor;
      cursor += height;
    }
  }

  // Bars go in only when the text is genuinely clear of them; the words always win.
  const drawBars = !!bars && bars.length >= BARS_MIN_COUNT && cursor <= BARS_TOP - BARS_CLEARANCE - COLUMN_TOP;
  const blockFloor = drawBars ? BARS_TOP - BARS_CLEARANCE : COLUMN_FLOOR;
  const blockTop = Math.max(COLUMN_TOP, COLUMN_TOP + Math.round((blockFloor - COLUMN_TOP - cursor) / 2));

  const layers: TextLayer[] = stacked.map((row) => ({
    input: row.input,
    left: row.left,
    top: blockTop + row.offset,
  }));
  if (blocks.identity) blocks.identity.top = blockTop + (blockOffsets.identity ?? 0);
  if (blocks.eyebrow) blocks.eyebrow.top = blockTop + (blockOffsets.eyebrow ?? 0);
  if (blocks.dots) blocks.dots.top = blockTop + (blockOffsets.dots ?? 0);

  if (drawBars && bars) {
    const { svg, width, height } = renderBarsSvg(bars, columnWidth);
    layers.push({ input: svg, left: bounds.left, top: BARS_TOP });
    blocks.bars = { left: bounds.left, top: BARS_TOP, width, height };
  }

  if (aside) {
    const asideRows = [
      await renderRaster(
        `<span size="13pt" weight="700" letter_spacing="1200" foreground="${OG_FAMILY_MUTED}">${escapePangoMarkup(aside.eyebrow)}</span>`,
        { fontFamily },
      ),
      await renderRow(
        { runs: [{ text: aside.title, color: OG_FAMILY_WHITE }], sizePt: 21, weight: 700, maxLines: 3 },
        ASIDE_WIDTH,
        fontFamily,
        'left',
      ),
      ...(await Promise.all(
        aside.lines.map((line) =>
          renderRow(
            { runs: [{ text: line, color: OG_FAMILY_MUTED }], sizePt: 16, weight: 500, maxLines: 2 },
            ASIDE_WIDTH,
            fontFamily,
            'left',
          ),
        ),
      )),
    ];
    let asideCursor = ASIDE_TOP;
    let asideRight = ASIDE_LEFT;
    for (const raster of asideRows) {
      layers.push({ input: raster.buffer, left: ASIDE_LEFT, top: asideCursor });
      asideRight = Math.max(asideRight, ASIDE_LEFT + raster.width);
      asideCursor += raster.height + 8;
    }
    blocks.aside = {
      left: ASIDE_LEFT,
      top: ASIDE_TOP,
      width: asideRight - ASIDE_LEFT,
      height: asideCursor - ASIDE_TOP,
    };
  }

  // The icon goes in before the wordmark, so the wordmark stays the last layer.
  const wordmark = await renderRaster(
    `<span size="16pt" weight="700" letter_spacing="1800" foreground="${WORDMARK_COLOR}">BOARDSESH</span>`,
    { fontFamily },
  );
  const wordmarkLeft = OG_FAMILY_WORDMARK_RIGHT - wordmark.width;
  // A missing or unreadable icon never costs the words: the wordmark is drawn on
  // its own and `iconError` tells the caller the card is not the final drawing,
  // so it must not be cached under the real key. The next card retries the read.
  const [{ icon, iconError }, wordmarkInk] = await Promise.all([
    getRoundedIcon().then(
      (buffer) => ({ icon: buffer, iconError: null }),
      (error: unknown) => ({ icon: null, iconError: error instanceof Error ? error.message : String(error) }),
    ),
    measureInk(wordmark.buffer),
  ]);
  const iconLeft = wordmarkLeft + wordmarkInk.left - OG_FAMILY_ICON_GAP - OG_FAMILY_ICON_SIZE;
  const iconTop =
    OG_FAMILY_WORDMARK_TOP + Math.round((wordmarkInk.top + wordmarkInk.bottom + 1 - OG_FAMILY_ICON_SIZE) / 2);
  if (icon) layers.push({ input: icon, left: iconLeft, top: iconTop });
  layers.push({ input: wordmark.buffer, left: wordmarkLeft, top: OG_FAMILY_WORDMARK_TOP });
  const brandTop = Math.min(iconTop, OG_FAMILY_WORDMARK_TOP);
  const brandBottom = Math.max(iconTop + OG_FAMILY_ICON_SIZE, OG_FAMILY_WORDMARK_TOP + wordmark.height);

  return {
    layers: layers.filter((layer) => layer.top >= 0 && layer.top < OG_IMAGE_HEIGHT),
    hero: {
      left: heroLeft,
      top: blockTop + heroOffset,
      width: heroRaster.width,
      height: heroRaster.height,
      pt: heroRaster.pt,
    },
    blocks,
    iconError,
    brand: {
      left: iconLeft,
      top: brandTop,
      width: OG_FAMILY_WORDMARK_RIGHT - iconLeft,
      height: brandBottom - brandTop,
    },
  };
}

// --- composition ----------------------------------------------------------

const SCRIM_FEATHER_WIDTH = 240;
const SCRIM_COLUMN_OPACITY = 0.92;
const SCRIM_GROUND_TINT_OPACITY = 0.4;
/** A no-art card keeps the neutral frost and grain showing through the ground. */
const SCRIM_NEUTRAL_FIELD_OPACITY = 0.62;

/**
 * Lays the family ground over the bokeh: a tint across the whole card, then a
 * feathered ramp into the near-solid column so the text never competes with it.
 * A card with no art takes one even tint, so the frost and grain still read.
 */
export function buildOgFamilyScrim(slot: OgFamilySlot): Buffer {
  const width = OG_IMAGE_WIDTH;
  const height = OG_IMAGE_HEIGHT;
  const art = SLOTS[slot].art;
  if (!art) {
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${OG_FAMILY_GROUND}" fill-opacity="${SCRIM_NEUTRAL_FIELD_OPACITY}"/></svg>`,
    );
  }
  const tint = `<rect width="${width}" height="${height}" fill="${OG_FAMILY_GROUND}" fill-opacity="${SCRIM_GROUND_TINT_OPACITY}"/>`;
  const columnLeft = SLOTS[slot].columnLeft;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tint}<defs><linearGradient id="scrim"><stop offset="0" stop-color="${OG_FAMILY_GROUND}" stop-opacity="0"/><stop offset="1" stop-color="${OG_FAMILY_GROUND}" stop-opacity="${SCRIM_COLUMN_OPACITY}"/></linearGradient></defs><rect x="${columnLeft - SCRIM_FEATHER_WIDTH}" width="${SCRIM_FEATHER_WIDTH}" height="${height}" fill="url(#scrim)"/><rect x="${columnLeft}" width="${width - columnLeft}" height="${height}" fill="${OG_FAMILY_GROUND}" fill-opacity="${SCRIM_COLUMN_OPACITY}"/></svg>`,
  );
}

export type OgFamilyArtLayers = {
  /** Board-sized folded board photo (raw RGBA), or null when no photo resolved. */
  plane: Buffer | null;
  /** Board-sized overlay (raw RGBA), or null when the plane already holds everything. */
  overlay: Buffer | null;
  width: number;
  height: number;
  placement: OgFamilyBoardPlacement;
  /** Draw the rounded frame around the board. Off for the bleeding `narrow` slice. */
  frame: boolean;
};

const PHOTO_CORNER_RADIUS = 16;

/**
 * A photograph as art-slot layers: rounded and hairline-bordered like the board
 * frame, right against the column like a board, sized by the caller to fit
 * `ogFamilyBoardBox('full')`. A public photo carries no overlay of its own: a
 * spray wall's climb is drawn into `image` before it gets here.
 */
export async function renderOgFamilyPhotoLayers(photo: {
  image: Buffer;
  width: number;
  height: number;
}): Promise<OgFamilyArtLayers> {
  const { image, width, height } = photo;
  const shape = `width="${width - 1}" height="${height - 1}" x="0.5" y="0.5" rx="${PHOTO_CORNER_RADIUS}"`;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect ${shape} fill="#fff"/></svg>`,
  );
  const border = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect ${shape} fill="none" stroke="#fff" stroke-opacity="0.14"/></svg>`,
  );
  const rounded = await sharp(image)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const { data } = await sharp(rounded)
    .composite([{ input: border }])
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    plane: data,
    overlay: null,
    width,
    height,
    placement: placeOgFamilyBoard('full', width, height),
    frame: false,
  };
}

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
  /** JPEG unless a caller's URL contract says otherwise (`/og/climb`'s `format`). */
  format?: OutputFormat;
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
    if (art.overlay) {
      const overlay = await visiblePortion(art.overlay, art.width, art.height, placement);
      layers.push({ ...overlay, left: placement.canvasLeft, top: placement.canvasTop, blend: 'over' });
    }
  }
  layers.push(...textLayers);

  const composited = sharp(background, {
    raw: { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, channels: 4 },
  }).composite(layers);

  return encodeOgCard(composited, format);
}
