import { z } from 'zod';
import { ClimbUuidSchema } from './primitives';

// GraphQL's built-in Int scalar is a signed 32-bit integer. Resolvers are also
// invoked directly in tests and internal code, so retain that transport bound
// here instead of letting those callers publish values GraphQL would reject.
const GRAPHQL_INT_MAX = 2_147_483_647;

/**
 * Input accepted by the high-frequency playback broadcast. The bounds mirror
 * the controls and playback engine: controls expose 0.5×–10× and the engine
 * cannot safely advance a frame faster than its 200 ms pace floor.
 */
export const PlaybackStateInputSchema = z.object({
  climbUuid: ClimbUuidSchema,
  frameIndex: z
    .number()
    .finite('Frame index must be finite')
    .int('Frame index must be an integer')
    .min(0, 'Frame index cannot be negative')
    .max(GRAPHQL_INT_MAX, 'Frame index is too large'),
  isPlaying: z.boolean(),
  speed: z
    .number()
    .finite('Playback speed must be finite')
    .min(0.5, 'Playback speed must be at least 0.5×')
    .max(10, 'Playback speed cannot exceed 10×'),
  paceMs: z
    .number()
    .finite('Playback pace must be finite')
    .int('Playback pace must be an integer')
    .min(200, 'Playback pace must be at least 200 ms')
    .max(GRAPHQL_INT_MAX, 'Playback pace is too large'),
  // React's useId() includes colons, so this intentionally stays a bounded
  // opaque string rather than adopting ParticipantIdSchema's character regex;
  // its 128-character cap matches the adjacent participant identifier.
  clientId: z.string().min(1, 'Client ID cannot be empty').max(128, 'Client ID too long').nullable().optional(),
});
