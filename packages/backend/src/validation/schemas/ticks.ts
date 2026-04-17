import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

const INSTAGRAM_URL_REGEX = /^https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|tv)\/([\w-]+)(?:[/?#]|$)/i;

/**
 * Tick status validation schema
 */
export const TickStatusSchema = z.enum(['flash', 'send', 'attempt'], {
  error: 'Status must be flash, send, or attempt',
});

/**
 * Save tick input validation schema
 */
export const SaveTickInputSchema = z.object({
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
  videoUrl: z.string().max(500).regex(INSTAGRAM_URL_REGEX, 'Must be an Instagram post or reel URL').optional().nullable(),
}).refine(
  (data) => {
    // A flash is by definition a first-try ascent, so attemptCount must be 1.
    // A send is any successful ascent — the attempt count on the row just
    // records how many tries that particular log represents (e.g. 1 when the
    // user is logging a single successful action, >1 when they're
    // back-filling a redpoint that took multiple tries). Both are valid.
    if (data.status === 'flash' && data.attemptCount !== 1) return false;
    return true;
  },
  { message: 'Flash requires attemptCount of 1', path: ['attemptCount'] }
).refine(
  (data) => {
    if (data.status === 'attempt' && data.quality !== undefined && data.quality !== null) return false;
    return true;
  },
  { message: 'Attempts cannot have quality ratings', path: ['quality'] }
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
  link: z.string().max(500).regex(INSTAGRAM_URL_REGEX, 'Must be an Instagram post or reel URL'),
  angle: z.number().int().min(0).max(90).optional().nullable(),
});

/**
 * Ascent feed input validation schema
 */
export const AscentFeedInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  boardType: BoardNameSchema.optional(),
  layoutIds: z.array(z.number().int().positive()).optional(),
  status: z.enum(['flash', 'send', 'attempt']).optional(),
  statusMode: z.enum(['both', 'send', 'attempt']).optional(),
  flashOnly: z.boolean().optional(),
  climbName: z.string().max(200).optional(),
  sortBy: z.enum(['recent', 'hardest', 'easiest', 'mostAttempts', 'climbName', 'loggedGrade', 'consensusGrade', 'date', 'attemptCount']).optional(),
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
export const UpdateTickInputSchema = z.object({
  status: z.enum(['flash', 'send', 'attempt']).optional(),
  attemptCount: z.number().int().min(1).max(999).optional(),
  quality: z.number().int().min(1).max(5).optional().nullable(),
  difficulty: z.number().int().optional().nullable(),
  isBenchmark: z.boolean().optional(),
  comment: z.string().max(2000).optional(),
}).refine(
  (data) => {
    if (data.status === 'flash' && data.attemptCount !== undefined && data.attemptCount !== 1) return false;
    if (data.status === 'send' && data.attemptCount !== undefined && data.attemptCount <= 1) return false;
    return true;
  },
  { message: 'Flash requires attemptCount of 1, send requires attemptCount > 1', path: ['attemptCount'] }
);
