import { z } from 'zod';
import { BoardPathSchema, SessionIdSchema, SessionNameSchema, LatitudeSchema, LongitudeSchema } from './primitives';
import { BoardConfigInputSchema } from './climbs';

/**
 * Create session input validation schema
 */
export const CreateSessionInputSchema = z.object({
  boardPath: BoardPathSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  name: SessionNameSchema,
  discoverable: z.boolean(),
  goal: z.string().max(500, 'Goal too long').optional(),
  isPermanent: z.boolean().optional(),
  boardIds: z.array(z.number().int().positive()).max(20).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color')
    .optional(),
  // Extra board configs to attach to the session beyond the primary board
  // encoded in boardPath. Capped to keep payload size bounded.
  boards: z.array(BoardConfigInputSchema).max(20).optional(),
});

/**
 * End session input validation schema
 */
export const EndSessionInputSchema = z.object({
  sessionId: SessionIdSchema,
});

/**
 * Session summary input validation schema
 */
export const SessionSummaryInputSchema = z.object({
  sessionId: SessionIdSchema,
});
