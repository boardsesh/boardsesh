import { z } from 'zod';

/**
 * Composite sync cursor input. Both components are optional (null on the first
 * pull). `updatedAt` is an ISO-8601 string; `syncSeq` is a stringified bigint.
 * Enforced here so a malformed cursor is a client-visible validation error
 * instead of an unhandled Postgres exception when the resolver casts it with
 * `::timestamp` / `::bigint`.
 *
 * Besides strict ISO-8601, the legacy 'YYYY-MM-DD HH:MM:SS[.ffffff]' shape is
 * accepted: pre-normalization servers emitted postgres.js timestamp strings
 * verbatim, and clients replay stored checkpoints, so rejecting that form
 * would permanently brick sync for anyone holding an old cursor. Both shapes
 * cast cleanly with `::timestamp`.
 */
const LEGACY_PG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

// Both accepted shapes must also be REAL timestamps: the resolver feeds the
// value to `::timestamp`, where '2026-13-45 25:61:61' (regex-valid) raises
// 22008 as an opaque 500 instead of a validation error. Date.parse returns NaN
// for out-of-range components in ISO-shaped strings, so it is the arbiter.
function isRealTimestamp(value: string): boolean {
  const isoShaped = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return !Number.isNaN(Date.parse(isoShaped));
}

export const SyncCursorInputSchema = z
  .object({
    // UTC-only on purpose (no `offset: true`): the server only ever emits 'Z'
    // timestamps, and the resolver's `::timestamp` cast silently DROPS an
    // offset — accepting '+05:30' here would shift the cursor by the offset
    // and skip rows. Better to reject what the query would corrupt.
    updatedAt: z
      .string()
      .datetime()
      .or(z.string().regex(LEGACY_PG_TIMESTAMP_PATTERN))
      .refine(isRealTimestamp, 'updatedAt must be a real timestamp')
      .optional()
      .nullable(),
    // Bounded at 19 digits so the value fits ::bigint (max 9223372036854775807
    // is 19 digits) — an unbounded digit string passes a bare \d+ regex and
    // then raises 22003 in Postgres as a 500.
    syncSeq: z
      .string()
      .regex(/^\d{1,19}$/, 'syncSeq must be a stringified integer')
      .optional()
      .nullable(),
  })
  .optional()
  .nullable();

/**
 * Page-size bound shared by every sync resolver. Matches the SDL default of 500
 * and caps the per-request row count so a client can't ask for an unbounded scan.
 */
export const SyncLimitSchema = z.number().int().min(1).max(500);

/** Exact document reads require a single positive layout/size id. */
export const SyncRequiredBoardScopeIdSchema = z.number().int().positive();

/**
 * Optional board-scope id (layoutId / sizeId) for the per-board sync resolvers.
 * A positive integer when present; null/undefined means "whole board type".
 */
export const SyncBoardScopeIdSchema = SyncRequiredBoardScopeIdSchema.optional().nullable();

/**
 * Optional audience for the per-board sync resolvers. Null/undefined means the
 * single-stream pull every client older than the split sends.
 */
export const SyncAudienceSchema = z.enum(['REFERENCE', 'PROTECTED']).optional().nullable();

export type SyncCursorInputValidated = z.infer<typeof SyncCursorInputSchema>;
