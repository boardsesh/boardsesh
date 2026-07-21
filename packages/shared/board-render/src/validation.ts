import { z } from 'zod';
import type { OutputFormat } from './types';

/** Board names the render pipeline accepts. */
export const VALID_BOARD_NAMES = new Set([
  'kilter',
  'tension',
  'moonboard',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
]);

/** Hard cap on the encoded frames string, to bound WASM work per request. */
export const MAX_FRAMES_LENGTH = 16_384;

export const MAX_SET_IDS = 10;

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
 * Strict query validation for the public `GET /og/climb` endpoint. Runs before
 * any CPU-heavy work: rejects bad input cheaply with a 400 so a crawler can't
 * push the backend into wasted WASM/sharp renders.
 */
export const ogClimbQuerySchema = z.object({
  board_name: z.enum(['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill']),
  layout_id: z.coerce.number().int().nonnegative(),
  size_id: z.coerce.number().int().nonnegative(),
  set_ids: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'set_ids must be a comma-separated list of integers')
    .refine((setIdsCsv) => setIdsCsv.split(',').length <= MAX_SET_IDS, `set_ids accepts at most ${MAX_SET_IDS} ids`)
    // Canonicalise (sort + dedupe) so equivalent queries render and cache identically.
    .transform((setIdsCsv) => [...new Set(setIdsCsv.split(',').map(Number))].sort((a, b) => a - b).join(',')),
  frames: z
    .string()
    .max(MAX_FRAMES_LENGTH, 'frames string is too large')
    .refine(isValidFramesString, 'frames contains invalid syntax'),
  format: z.enum(['webp', 'png', 'jpeg', 'jpg']).optional(),
});

export type OgClimbQuery = z.infer<typeof ogClimbQuerySchema>;
