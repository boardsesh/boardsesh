import { z } from 'zod';

/**
 * Social entity type validation schema
 */
export const SocialEntityTypeSchema = z.enum([
  'playlist_climb',
  'climb',
  'tick',
  'comment',
  'proposal',
  'board',
  'gym',
  'session',
]);

/**
 * Sort mode validation schema
 */
export const SortModeSchema = z.enum(['new', 'top', 'controversial', 'hot']);

/**
 * Time period validation schema
 */
export const TimePeriodSchema = z.enum(['hour', 'day', 'week', 'month', 'year', 'all']);

/**
 * Add comment input validation schema
 */
export const AddCommentInputSchema = z.object({
  entityType: SocialEntityTypeSchema,
  entityId: z.string().min(1, 'Entity ID cannot be empty').max(200, 'Entity ID too long'),
  parentCommentUuid: z.string().uuid('Invalid UUID format').optional(),
  body: z.string().min(1, 'Comment body cannot be empty').max(2000, 'Comment body too long'),
  isPublic: z.boolean().optional(),
});

/**
 * Update comment input validation schema
 */
export const UpdateCommentInputSchema = z.object({
  commentUuid: z.string().uuid('Invalid UUID format'),
  body: z.string().min(1, 'Comment body cannot be empty').max(2000, 'Comment body too long'),
});

/**
 * Vote input validation schema
 */
export const VoteInputSchema = z.object({
  entityType: SocialEntityTypeSchema,
  entityId: z.string().min(1, 'Entity ID cannot be empty').max(200, 'Entity ID too long'),
  value: z.number().int().refine((v) => v === 1 || v === -1, {
    message: 'Vote value must be +1 or -1',
  }),
});

/**
 * Comments query input validation schema
 */
export const CommentsInputSchema = z.object({
  entityType: SocialEntityTypeSchema,
  entityId: z.string().min(1).max(200),
  parentCommentUuid: z.string().uuid('Invalid UUID format').optional(),
  sortBy: SortModeSchema.optional().default('new'),
  timePeriod: TimePeriodSchema.optional().default('all'),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Bulk vote summary input validation schema
 */
export const BulkVoteSummaryInputSchema = z.object({
  entityType: SocialEntityTypeSchema,
  entityIds: z.array(z.string().min(1).max(200)).min(1).max(100),
});
