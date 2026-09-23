import sharp from 'sharp';
import { getGradeColor } from '@boardsesh/board-constants';
import { escapePangoMarkup } from './validation';
import { OG_CARD_BOARD_BOX, OG_CARD_COLUMN_GAP, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';

/**
 * The climb-identity column drawn on the right of a `/og/climb` card.
 *
 * Text is typeset by libvips' Pango backend (`sharp({ text })`) rather than by
 * SVG `<text>`: Pango does shaping, bidi and wrapping, and it keeps caller text
 * out of an XML document entirely — the string goes to a text layout engine, not
 * to a parser that also understands entities and external references.
 *
 * Every string that reaches Pango must be escaped first. libvips calls
 * `pango_parse_markup` unconditionally, so an unescaped `&` throws rather than
 * rendering literally; see `escapePangoMarkup`.
 */

/** Left edge of the text column. */
const COLUMN_LEFT = OG_CARD_BOARD_BOX.left + OG_CARD_BOARD_BOX.width + OG_CARD_COLUMN_GAP;
// Mirrors the board's outer inset, so the column is the `OG_CARD_TEXT_COLUMN_WIDTH`
// the board box was sized against rather than 16px narrower than it.
const COLUMN_RIGHT = OG_IMAGE_WIDTH - OG_CARD_BOARD_BOX.left;
const COLUMN_WIDTH = COLUMN_RIGHT - COLUMN_LEFT;

/** Rows are laid out downward from here and must not pass `COLUMN_FLOOR`. */
const COLUMN_TOP = 48;
const COLUMN_FLOOR = 546;

/** Baseline for the wordmark, which is never dropped. */
const WORDMARK_TOP = 574;

/**
 * Pango renders at this dpi throughout, so a point size maps to a predictable
 * pixel size. `dpi` and `height` are mutually exclusive in sharp, which is also
 * what stops us from accidentally asking libvips to auto-fit text to a box — a
 * long climb name would come back microscopic instead of wrapped.
 */
const DPI = 96;

const FALLBACK_TEXT_COLOR = '#F8FAFC';
const NAME_COLOR = '#F1F5F9';
const BOARD_LINE_COLOR = '#94A3B8';
const SETTER_COLOR = '#64748B';
const ANGLE_COLOR = '#5EEAD4';
const WORDMARK_COLOR = '#475569';

/** Room for three lines of the climb name before it has to be truncated. */
const MAX_NAME_HEIGHT = 156;
const NAME_TRUNCATION_ATTEMPTS = 4;

export type OgCardContent = {
  /** Climb name, already normalised by `normalizeOgCardText`. */
  name?: string;
  /** Grade label, e.g. `7a/V6`. */
  grade?: string;
  /** Setter's display name, already normalised. */
  setter?: string;
  /** Board wall angle in degrees. */
  angle?: number;
  /** e.g. `Kilter · Original 12×12`, derived server-side from the board config. */
  boardLine?: string;
  /** Font family passed to Pango. Left to fontconfig's fallback chain when unset. */
  fontFamily?: string;
};

type TextLayer = { input: Buffer; left: number; top: number };

/**
 * A string is treated as right-to-left when its first strong character is.
 *
 * Each row is its own raster, so bidi can never reorder an Arabic climb name
 * against the Latin chrome around it; this only decides which edge of the column
 * the row is anchored to.
 */
function isRightToLeft(value: string): boolean {
  return /^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u.test(value);
}

async function renderText(
  markup: string,
  options: { fontFamily?: string; width?: number; align?: 'left' | 'right' },
): Promise<{ buffer: Buffer; width: number; height: number }> {
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

function span(text: string, { size, weight, color }: { size: number; weight: number; color: string }): string {
  return `<span size="${size}pt" weight="${weight}" foreground="${color}">${escapePangoMarkup(text)}</span>`;
}

/**
 * Fit the climb name into at most `MAX_NAME_HEIGHT`, shortening it if a long
 * name would push the rows below it off the card.
 *
 * Measure-then-retry rather than counting characters: the column is a
 * proportional font and the name may be in any script, so the only honest
 * measurement is the one Pango makes.
 */
async function renderName(
  name: string,
  fontFamily: string | undefined,
  align: 'left' | 'right',
): Promise<{ buffer: Buffer; width: number; height: number }> {
  let candidate = name;

  for (let attempt = 0; attempt < NAME_TRUNCATION_ATTEMPTS; attempt++) {
    const rendered = await renderText(span(candidate, { size: 30, weight: 700, color: NAME_COLOR }), {
      fontFamily,
      width: COLUMN_WIDTH,
      align,
    });
    if (rendered.height <= MAX_NAME_HEIGHT) return rendered;

    const codePoints = Array.from(candidate.replace(/…$/u, ''));
    const keep = Math.max(1, Math.floor(codePoints.length * 0.85));
    candidate = `${codePoints.slice(0, keep).join('').trimEnd()}…`;
  }

  return renderText(span(candidate, { size: 30, weight: 700, color: NAME_COLOR }), {
    fontFamily,
    width: COLUMN_WIDTH,
    align,
  });
}

/**
 * Build the sharp composite layers for the identity column.
 *
 * Returns an empty array when there is nothing to say, so a card built by an
 * already-shipped client that sends no text params renders exactly as it would
 * have — the board, and no empty furniture.
 */
export async function renderOgCardLayers(content: OgCardContent): Promise<TextLayer[]> {
  const name = content.name?.trim() ?? '';
  const grade = content.grade?.trim() ?? '';
  const setter = content.setter?.trim() ?? '';
  const boardLine = content.boardLine?.trim() ?? '';
  if (!name && !grade && !setter && !boardLine) return [];

  const { fontFamily } = content;
  // Whichever line the card actually leads with. Deciding from `name` alone
  // left-anchored a card that had only a grade and an Arabic setter.
  const rightToLeft = isRightToLeft(name || setter || boardLine);
  const align = rightToLeft ? 'right' : 'left';
  const anchor = (width: number) => (rightToLeft ? COLUMN_RIGHT - width : COLUMN_LEFT);

  // Rows are stacked from zero, then the whole block is centred in the column's
  // vertical budget. Laying out at a fixed top instead leaves a card with a
  // short name looking like the bottom two-thirds failed to render.
  const rows: { input: Buffer; left: number; offset: number }[] = [];
  let cursor = 0;

  if (grade) {
    const hero = await renderText(
      span(grade, { size: 64, weight: 800, color: getGradeColor(grade) ?? FALLBACK_TEXT_COLOR }),
      { fontFamily },
    );
    rows.push({ input: hero.buffer, left: anchor(hero.width), offset: cursor });

    if (content.angle !== undefined) {
      const chip = await renderText(span(`${content.angle}°`, { size: 21, weight: 600, color: ANGLE_COLOR }), {
        fontFamily,
      });
      // Anchored to the opposite edge from the grade, and vertically centred on
      // it, so the pair reads as one row whichever direction the name runs.
      rows.push({
        input: chip.buffer,
        left: rightToLeft ? COLUMN_LEFT : COLUMN_RIGHT - chip.width,
        offset: cursor + Math.max(0, Math.round((hero.height - chip.height) / 2)),
      });
    }

    cursor += hero.height + 26;
  } else if (content.angle !== undefined) {
    // A climb with no recorded difficulty still has a wall angle, and the chip
    // is only laid out beside the grade because that is where it looks right —
    // not because it depends on one.
    const chip = await renderText(span(`${content.angle}\u00B0`, { size: 21, weight: 600, color: ANGLE_COLOR }), {
      fontFamily,
    });
    rows.push({ input: chip.buffer, left: anchor(chip.width), offset: cursor });
    cursor += chip.height + 18;
  }

  if (name) {
    const rendered = await renderName(name, fontFamily, align);
    rows.push({ input: rendered.buffer, left: anchor(rendered.width), offset: cursor });
    cursor += rendered.height + 20;
  }

  // Bottom-up: a long name is allowed to push the supporting lines off rather
  // than overlap them or the wordmark.
  for (const [text, size, color, gap] of [
    [boardLine, 18, BOARD_LINE_COLOR, 10],
    [setter, 17, SETTER_COLOR, 0],
  ] as const) {
    if (!text) continue;
    // Width-bounded like the name. A long board line — "Touchstone · Dungeon
    // Trainer · Full Size" — otherwise runs past the column and is clipped at
    // the canvas edge instead of wrapping.
    const rendered = await renderText(span(text, { size, weight: 500, color }), {
      fontFamily,
      width: COLUMN_WIDTH,
      align,
    });
    if (cursor + rendered.height > COLUMN_FLOOR - COLUMN_TOP) break;
    rows.push({ input: rendered.buffer, left: anchor(rendered.width), offset: cursor });
    cursor += rendered.height + gap;
  }

  const blockTop = Math.max(COLUMN_TOP, COLUMN_TOP + Math.round((COLUMN_FLOOR - COLUMN_TOP - cursor) / 2));
  const layers: TextLayer[] = rows.map((row) => ({ input: row.input, left: row.left, top: blockTop + row.offset }));

  const wordmark = await renderText(
    `<span size="15pt" weight="700" letter_spacing="3000" foreground="${WORDMARK_COLOR}">BOARDSESH</span>`,
    { fontFamily },
  );
  layers.push({ input: wordmark.buffer, left: COLUMN_LEFT, top: WORDMARK_TOP });

  return layers.filter((layer) => layer.top >= 0 && layer.top < OG_IMAGE_HEIGHT);
}
