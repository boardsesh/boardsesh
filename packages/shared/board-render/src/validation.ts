import { z } from 'zod';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import type { OutputFormat } from './types';

/**
 * Board names the render pipeline accepts. Single source for the Set and the zod
 * enum, and derived from `SUPPORTED_BOARDS` rather than restated: this list gates
 * `/api/internal/board-render` and the backend's `GET /og/climb`, so a board
 * missing from a hand-kept copy is a silent 400 on every share card and preview
 * for that board — the failure Woods would have shipped with.
 */
const VALID_BOARD_NAME_LIST = SUPPORTED_BOARDS;

export const VALID_BOARD_NAMES: ReadonlySet<string> = new Set(VALID_BOARD_NAME_LIST);

/**
 * Narrowing form of the check above, so a handler that has validated a board
 * name does not then have to assert it.
 *
 * Derived from `SUPPORTED_BOARDS` like the set itself, so a board added to the
 * schema is accepted here the moment it is added there — the cast this replaces
 * would have kept compiling while quietly rejecting it.
 */
export function isSupportedBoardName(boardName: string): boardName is BoardName {
  return VALID_BOARD_NAMES.has(boardName);
}

/** Hard cap on the encoded frames string, to bound WASM work per request. */
export const MAX_FRAMES_LENGTH = 16_384;

/**
 * Hard cap on how many hold sets one render may composite.
 *
 * Sized against the real catalogue, not guessed: the widest shipped config is
 * Decoy layout 2 / size 1, which carries 19 sets. `set-ids-catalogue.test.ts`
 * walks every entry in `SETS` and fails if one outgrows this number, because
 * the previous cap of 10 silently 400'd every Decoy climb — both its share card
 * and the board image on the page itself.
 */
export const MAX_SET_IDS = 24;

/**
 * `MAX_SET_IDS` comma-separated safe integers. Apply this byte-sized bound
 * before regex or split work so hostile query strings cannot make validation
 * scale with an arbitrary input length.
 */
export const MAX_SET_IDS_LENGTH = MAX_SET_IDS * String(Number.MAX_SAFE_INTEGER).length + (MAX_SET_IDS - 1);

/**
 * Hard ceiling on the rendered pixel count. Every in-flight plane costs 4 bytes
 * a pixel, so this is what stops a hand-crafted request from sizing a render
 * past what the process can hold. The largest real board is Kilter's 1080×2498
 * (~2.70 MP) — `board-dimensions.test.ts` fails if a board ever grows past this
 * number, so a new board shows up as a red test rather than a 400 in
 * production. Oversized requests are rejected, never resampled.
 */
export const MAX_RENDER_OUTPUT_PIXELS = 3_000_000;

export function normalizeOutputFormat(format: string): OutputFormat | null {
  if (format === 'jpg') return 'jpeg';
  if (format === 'webp' || format === 'png' || format === 'jpeg') return format;
  return null;
}

/**
 * Validate a single frames segment. A segment is a run of `p{placement}r{role}`
 * pairs, optionally prefixed with a `"` (Aurora delta marker) and interleaved
 * with `x{placement}` removals.
 */
export function isValidFrameSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  let cursor = 0;

  if (segment[cursor] === '"') {
    cursor++;
  }

  if (cursor >= segment.length) return false;

  while (cursor < segment.length) {
    const current = segment[cursor];
    if (current === 'x') {
      cursor++;
      const start = cursor;
      while (cursor < segment.length && segment[cursor] >= '0' && segment[cursor] <= '9') {
        cursor++;
      }
      if (cursor === start) return false;
      continue;
    }

    if (current !== 'p') return false;
    cursor++;
    const placementStart = cursor;
    while (cursor < segment.length && segment[cursor] >= '0' && segment[cursor] <= '9') {
      cursor++;
    }
    if (cursor === placementStart || segment[cursor] !== 'r') return false;

    cursor++;
    const roleStart = cursor;
    while (cursor < segment.length && segment[cursor] >= '0' && segment[cursor] <= '9') {
      cursor++;
    }
    if (cursor === roleStart) return false;
  }

  return true;
}

export function isValidFramesString(frames: string): boolean {
  if (frames.length === 0) return true;
  return frames.split(',').every(isValidFrameSegment);
}

/**
 * `render_mode`, `glow_falloff`, `glyphs` and `field_color` query params,
 * shared by the web `board-render` route and the backend's `GET /og/climb` —
 * see docs/og-climb.md.
 *
 * `render_mode` defaults to `aura`, the drawing the app has shipped since 2.4.
 * Every Boardsesh caller sends it explicitly anyway — the params are the
 * Cloudflare cache key, and a response cached `immutable` for a year cannot be
 * re-drawn in place — so this default is for the callers we do not control: a
 * store binary from before the change that prewarms a bare URL, and any third
 * party embedding the endpoint. Those get the current drawing rather than one
 * frozen at the moment their build shipped.
 *
 * The other three still default closed (soft/off/unset); `field_color` unset
 * means the light field, on which `veilOpacityFor` turns the veil off.
 */
export const renderModeSchema = z.enum(['classic', 'aura']).default('aura');
export const glowFalloffSchema = z.enum(['soft', 'plateau']).default('soft');
/** Accepts the query-string spellings of a boolean flag; unset -> off. */
export const glyphsQuerySchema = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true');
export const fieldColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'field_color must be a #rrggbb hex color')
  .optional();

export const boardseshRenderQuerySchema = z.object({
  render_mode: renderModeSchema,
  glow_falloff: glowFalloffSchema,
  glyphs: glyphsQuerySchema,
  field_color: fieldColorSchema,
});

export type BoardseshRenderQuery = z.infer<typeof boardseshRenderQuerySchema>;

/**
 * The grade vocabulary a card will draw: `V7`, `7B+`, `6c+`, `5.12a`, `V8/7B`.
 *
 * Exported because the URL builder has to apply it too. A grade that fails here
 * is a 400, and a 400 is no card at all — so a caller that cannot match it must
 * drop the grade rather than send it and lose the whole image.
 */
export const OG_CARD_GRADE_PATTERN = /^[A-Za-z0-9+/. -]{1,16}$/;

/** Raw query-string bounds, applied before any per-codepoint work. */
export const MAX_CARD_NAME_PARAM_LENGTH = 512;
export const MAX_CARD_SETTER_PARAM_LENGTH = 256;

/** What survives normalisation and actually reaches the card. */
export const MAX_CARD_NAME_CODEPOINTS = 64;
export const MAX_CARD_SETTER_CODEPOINTS = 32;

/**
 * Invisible characters that are not in `\p{C}` but would still let a crafted URL
 * render something other than what it says: the zero-width space, the
 * left/right marks, the bidi overrides and isolates, and the byte-order mark.
 *
 * U+200C and U+200D are deliberately NOT in that list. Both are text, not
 * decoration: the joiner is what holds a compound emoji together, so stripping
 * it turns a climber emoji into two glyphs, and the non-joiner is semantic in
 * Persian and Arabic. Climb names contain emoji — the catalogue has one whose
 * whole name is an emoji.
 */
const INVISIBLE_CHARACTERS = /[\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/**
 * Bound a caller-supplied string before it is drawn onto a share card.
 *
 * `/og/climb` is unauthenticated and its responses are immutable for a year, so
 * whatever text a URL carries is what that URL renders for as long as anyone
 * holds it. This is a deny-list rather than an allow-list of scripts on purpose:
 * real climb names in the catalogue include Japanese katakana, Chinese, Hebrew
 * and emoji, and a script allow-list would blank them.
 *
 * Truncation counts code points via `Array.from`, so an emoji costs one
 * character rather than being cut in half into a lone surrogate.
 */
export function normalizeOgCardText(raw: string, maxCodePoints: number): string {
  const stripped = raw
    .normalize('NFC')
    // Whitespace becomes a space BEFORE control characters are stripped: a tab
    // and a newline are both `\p{C}`, so stripping first would silently join
    // the words either side of them.
    .replaceAll(/\s/gu, ' ')
    .replaceAll(INVISIBLE_CHARACTERS, '')
    // `\p{C}` minus the format category, which is handled by the explicit list
    // above instead. `\p{Cf}` holds the bidi overrides AND the joiners, and the
    // joiners are text: stripping the whole category takes a compound emoji
    // apart.
    .replaceAll(/[\p{Cc}\p{Co}\p{Cs}\p{Cn}]/gu, '')
    .replaceAll(/ {2,}/gu, ' ')
    .trim();

  const codePoints = Array.from(stripped);
  return codePoints.length <= maxCodePoints ? stripped : codePoints.slice(0, maxCodePoints).join('').trim();
}

/**
 * Escape text for Pango markup.
 *
 * libvips calls `pango_parse_markup` on every string it typesets, unconditionally
 * — there is no plain-text mode. An unescaped `&` or `<` does not render
 * literally, it throws `text: invalid markup in text`, so a climb called
 * "Rock & Roll" would 500 the endpoint rather than look wrong. Verified against
 * sharp 0.34.5 on both macOS and node:22-alpine.
 */
export function escapePangoMarkup(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Strict query validation for the public `GET /og/climb` endpoint. Runs before
 * any CPU-heavy work: rejects bad input cheaply with a 400 so a crawler can't
 * push the backend into wasted WASM/sharp renders.
 */
export const ogClimbQuerySchema = z
  .object({
    board_name: z.enum(VALID_BOARD_NAME_LIST),
    layout_id: z.coerce.number().int().nonnegative(),
    size_id: z.coerce.number().int().nonnegative(),
    set_ids: z
      .string()
      .max(MAX_SET_IDS_LENGTH, 'set_ids is too large')
      .regex(/^\d+(,\d+)*$/, 'set_ids must be a comma-separated list of integers')
      .refine((setIdsCsv) => setIdsCsv.split(',').length <= MAX_SET_IDS, `set_ids accepts at most ${MAX_SET_IDS} ids`)
      // Canonicalise (sort + dedupe) so equivalent queries render and cache identically.
      .transform((setIdsCsv) => [...new Set(setIdsCsv.split(',').map(Number))].sort((a, b) => a - b).join(',')),
    frames: z
      .string()
      // Required: an empty frames string would render a blank board and cache it
      // with immutable headers as if it were a real climb card.
      .min(1, 'frames is required')
      .max(MAX_FRAMES_LENGTH, 'frames string is too large')
      .refine(isValidFramesString, 'frames contains invalid syntax'),
    format: z.enum(['webp', 'png', 'jpeg', 'jpg']).optional(),
    // Climb identity drawn on the card. All optional, so a URL built by an
    // already-shipped mobile binary still renders — it just gets the board on
    // its own. Deliberately NOT ascents or quality: those tick constantly, and
    // every tick would mint a new URL against a year-long immutable cache.
    n: z
      .string()
      .max(MAX_CARD_NAME_PARAM_LENGTH, 'n is too large')
      .transform((name) => normalizeOgCardText(name, MAX_CARD_NAME_CODEPOINTS))
      .optional(),
    s: z
      .string()
      .max(MAX_CARD_SETTER_PARAM_LENGTH, 's is too large')
      .transform((setter) => normalizeOgCardText(setter, MAX_CARD_SETTER_CODEPOINTS))
      .optional(),
    // Grades are a closed vocabulary across every board we render — `V7`,
    // `7B+`, `6c+`, `5.12a`, `V8/7B` — so this one gets an allow-list rather
    // than the free-text treatment.
    g: z
      .string()
      .regex(OG_CARD_GRADE_PATTERN, 'g must be a grade label')
      // The charset admits spaces, so `g=%20%20` passes the regex, renders
      // nothing, and still hashes to its own byte-cache entry. Trim first and
      // require something left, so a blank grade keys as no grade.
      .transform((grade) => grade.trim())
      .refine((grade) => grade.length > 0, 'g must be a grade label')
      .optional(),
    // Wide on purpose. Grasshopper's angle list starts at -5, and a bound that
    // clipped it would 400 — which is not a missing angle on the card, it is no
    // card at all. `og-card-angles.test.ts` walks every board's angle list and
    // fails if one ever falls outside this.
    angle: z.coerce.number().int().min(-90).max(90).optional(),
  })
  .extend(boardseshRenderQuerySchema.shape);

export type OgClimbQuery = z.infer<typeof ogClimbQuerySchema>;
