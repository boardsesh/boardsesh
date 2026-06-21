import { z } from 'zod';
import { BETA_VIDEO_URL_REGEX, BETA_VIDEO_URL_VALIDATION_MESSAGE } from '@boardsesh/shared-schema';
import { ExternalUUIDSchema, BoardNameSchema, UUIDSchema } from './primitives';

const CLIMBED_AT_FUTURE_TOLERANCE_MS = 60_000;

/**
 * Tick status validation schema
 */
export const TickStatusSchema = z.enum(['flash', 'send', 'attempt'], {
  error: 'Status must be flash, send, or attempt',
});

/**
 * Save tick input validation schema
 */
export const SaveTickInputSchema = z
  .object({
    boardType: BoardNameSchema,
    climbUuid: ExternalUUIDSchema,
    angle: z.number().int().min(0).max(90),
    isMirror: z.boolean(),
    status: TickStatusSchema,
    attemptCount: z.number().int().min(1).max(999),
    quality: z.number().int().min(1).max(5).optional().nullable(),
    difficulty: z.number().int().optional().nullable(),
    isBenchmark: z.boolean(),
    comment: z.string().max(2000),
    climbedAt: z.string(),
    sessionId: z.string().optional(),
    layoutId: z.number().int().positive().optional(),
    sizeId: z.number().int().positive().optional(),
    setIds: z.string().min(1).optional(),
    boardUuid: UUIDSchema.optional(),
    boardId: z.number().int().positive().optional().nullable(),
    videoUrl: z.string().max(500).regex(BETA_VIDEO_URL_REGEX, BETA_VIDEO_URL_VALIDATION_MESSAGE).optional().nullable(),
  })
  .refine(
    (data) => {
      // A flash is by definition a first-try ascent, so attemptCount must be 1.
      // A send is any successful ascent — the attempt count on the row just
      // records how many tries that particular log represents (e.g. 1 when the
      // user is logging a single successful action, >1 when they're
      // back-filling a redpoint that took multiple tries). Both are valid.
      if (data.status === 'flash' && data.attemptCount !== 1) return false;
      return true;
    },
    { message: 'Flash requires attemptCount of 1', path: ['attemptCount'] },
  );

/**
 * Get ticks input validation schema
 */
export const GetTicksInputSchema = z.object({
  boardType: BoardNameSchema,
  climbUuids: z.array(ExternalUUIDSchema).optional(),
});

/**
 * Attach beta link input validation schema
 */
export const AttachBetaLinkInputSchema = z.object({
  boardType: BoardNameSchema,
  climbUuid: ExternalUUIDSchema,
  link: z.string().max(500).regex(BETA_VIDEO_URL_REGEX, BETA_VIDEO_URL_VALIDATION_MESSAGE),
  // When tickUuid is provided the stored angle comes from the resolved tick,
  // not from this field. Clients may omit angle in that case. If both are
  // supplied and disagree, the resolver throws BETA_LINK_TICK_MISMATCH.
  angle: z.number().int().min(0).max(90).optional().nullable(),
  tickUuid: UUIDSchema.optional().nullable(),
});

/**
 * instagramBetaScan input validation schema.
 *
 * A scraped-post payload fed to the beta-import scanner. `boardType` is the
 * default board for posts whose caption doesn't name one; the per-post caption
 * can still override it (see parseInstagramBetaCaption). Posts are capped at
 * 2000 — well above a single account's realistic beta backlog, low enough to
 * bound the per-call resolution + dedup work.
 */
export const InstagramScanPostInputSchema = z.object({
  shortcode: z.string().min(1, 'Shortcode cannot be empty').max(100, 'Shortcode too long'),
  caption: z.string().max(5000).optional().nullable(),
  takenAt: z.string().max(100).optional().nullable(),
});

export const InstagramBetaScanInputSchema = z.object({
  // Scoped to the boards whose share captions use the quoted `"name" @ angle°`
  // format the parser understands and that the import UI offers. Other boards
  // (e.g. MoonBoard's comma format) are rejected rather than silently
  // zero-matching.
  boardType: z.enum(['kilter', 'tension']),
  posts: z.array(InstagramScanPostInputSchema).max(2000, 'Too many posts in a single scan'),
});

/**
 * Ascent feed input validation schema
 */
export const AscentFeedInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  boardType: BoardNameSchema.optional(),
  boardTypes: z.array(BoardNameSchema).optional(),
  layoutIds: z.array(z.number().int().positive()).optional(),
  status: z.enum(['flash', 'send', 'attempt']).optional(),
  statusMode: z.enum(['both', 'send', 'attempt']).optional(),
  flashOnly: z.boolean().optional(),
  climbName: z.string().max(200).optional(),
  sortBy: z
    .enum([
      'recent',
      'hardest',
      'easiest',
      'mostAttempts',
      'climbName',
      'loggedGrade',
      'consensusGrade',
      'date',
      'attemptCount',
    ])
    .optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  secondarySortBy: z.enum(['climbName', 'loggedGrade', 'consensusGrade', 'date', 'attemptCount']).optional(),
  secondarySortOrder: z.enum(['asc', 'desc']).optional(),
  minDifficulty: z.number().int().min(0).optional(),
  maxDifficulty: z.number().int().min(0).optional(),
  minAngle: z.number().int().min(0).max(90).optional(),
  maxAngle: z.number().int().min(0).max(90).optional(),
  benchmarkOnly: z.boolean().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

/**
 * Update tick input validation schema
 */
export const UpdateTickInputSchema = z
  .object({
    status: z.enum(['flash', 'send', 'attempt']).optional(),
    attemptCount: z.number().int().min(1).max(999).optional(),
    quality: z.number().int().min(1).max(5).optional().nullable(),
    difficulty: z.number().int().optional().nullable(),
    isBenchmark: z.boolean().optional(),
    comment: z.string().max(2000).optional(),
    climbedAt: z
      .string()
      .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Climbed at must be a valid date')
      .refine(
        (value) => new Date(value).getTime() <= Date.now() + CLIMBED_AT_FUTURE_TOLERANCE_MS,
        'Climbed at cannot be in the future',
      )
      .optional(),
  })
  .refine(
    (data) => {
      if (data.status === 'flash' && data.attemptCount !== undefined && data.attemptCount !== 1) return false;
      return true;
    },
    { message: 'Flash requires attemptCount of 1', path: ['attemptCount'] },
  );
