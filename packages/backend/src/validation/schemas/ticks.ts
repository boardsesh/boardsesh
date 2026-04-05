import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

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
}).refine(
  (data) => {
    if (data.status === 'flash' && data.attemptCount !== 1) return false;
    if (data.status === 'send' && data.attemptCount <= 1) return false;
    return true;
  },
  { message: 'Flash requires attemptCount of 1, send requires attemptCount > 1', path: ['attemptCount'] }
).refine(
  (data) => {
    if (data.status === 'attempt' && data.quality !== undefined && data.quality !== null) return false;
    return true;
  },
  { message: 'Attempts cannot have quality ratings', path: ['quality'] }
);

/**
 * Update tick input validation schema
 */
export const UpdateTickInputSchema = z.object({
  uuid: z.string().min(1),
  status: TickStatusSchema.optional(),
  attemptCount: z.number().int().min(1).max(999).optional(),
  quality: z.number().int().min(1).max(5).optional().nullable(),
  comment: z.string().max(2000).optional(),
}).refine(
  (data) => {
    if (data.status === 'flash' && data.attemptCount !== undefined && data.attemptCount !== 1) return false;
    if (data.status === 'send' && data.attemptCount !== undefined && data.attemptCount <= 1) return false;
    return true;
  },
  { message: 'Flash requires attemptCount of 1, send requires attemptCount > 1', path: ['attemptCount'] }
).refine(
  (data) => {
    if (data.status === 'attempt' && data.quality !== undefined && data.quality !== null) return false;
    return true;
  },
  { message: 'Attempts cannot have quality ratings', path: ['quality'] }
);

/**
 * Delete tick input validation schema
 */
export const DeleteTickInputSchema = z.object({
  uuid: z.string().min(1),
});

/**
 * Get ticks input validation schema
 */
export const GetTicksInputSchema = z.object({
  boardType: BoardNameSchema,
  climbUuids: z.array(ExternalUUIDSchema).optional(),
});

/**
 * Ascent feed input validation schema
 */
export const AscentFeedInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});
