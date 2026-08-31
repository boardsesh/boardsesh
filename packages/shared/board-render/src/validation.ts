import { z } from 'zod';
import { STATIC_BOARD_RENDER_NAMES } from '@boardsesh/board-config';
import type { OutputFormat } from './types';

/**
 * Board names the render pipeline accepts. Single source for the Set and the zod
 * enum, and derived from the total capability table rather than restated. This
 * list gates `/api/internal/board-render` and the backend's `GET /og/climb`.
 * Runtime-geometry boards stay out until those synchronous endpoints can load
 * their signed geometry instead of falling through to Aurora calibration.
 */
const VALID_BOARD_NAME_LIST = STATIC_BOARD_RENDER_NAMES;

export const VALID_BOARD_NAMES: ReadonlySet<string> = new Set(VALID_BOARD_NAME_LIST);

/** Hard cap on the encoded frames string, to bound WASM work per request. */
export const MAX_FRAMES_LENGTH = 16_384;

export const MAX_SET_IDS = 10;

/**
 * Ten comma-separated safe integers. Apply this byte-sized bound before regex
 * or split work so hostile query strings cannot make validation scale with an
 * arbitrary input length.
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
 * see docs/og-climb.md. All four default closed (classic/soft/off/unset), so
 * an endpoint that never reads a value from this schema still renders
 * classic (issue #2202: web and OG stay classic-by-default in this PR; a
 * later PR flips the default).
 */
export const renderModeSchema = z.enum(['classic', 'boardsesh']).default('classic');
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
  })
  .extend(boardseshRenderQuerySchema.shape);

export type OgClimbQuery = z.infer<typeof ogClimbQuerySchema>;
