import { z } from 'zod';
import { SESSION_NAME_MAX_LENGTH } from '@boardsesh/shared-schema';
import {
  BoardPathSchema,
  SessionIdSchema,
  SessionNameSchema,
  SessionNotesSchema,
  LatitudeSchema,
  LongitudeSchema,
  UUIDSchema,
} from './primitives';

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
  // Absent or null means public.
  isPublic: z.boolean().nullable().optional(),
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

/**
 * Update session input validation schema. `name` and `notes` use
 * `.nullable().optional()` — update semantics distinguish an absent field
 * (leave unchanged) from an explicit null (clear it). Deliberately does NOT
 * reuse `SessionNameSchema`, which is `.optional()` without `.nullable()`.
 */
export const UpdateSessionInputSchema = z.object({
  sessionId: SessionIdSchema,
  name: z.string().max(SESSION_NAME_MAX_LENGTH, 'Session name too long').nullable().optional(),
  notes: SessionNotesSchema.nullable().optional(),
  // Absent or null leaves visibility unchanged — there is nothing to "clear".
  isPublic: z.boolean().nullable().optional(),
});

/**
 * `followedLiveSessions` arguments. `limit` is clamped by the resolver (default
 * 10, max 20) rather than rejected, matching `boardHistory`'s limit handling.
 */
export const FollowedLiveSessionsArgsSchema = z.object({
  boardUuid: UUIDSchema.nullable().optional(),
  limit: z.number().int().nullable().optional(),
});
