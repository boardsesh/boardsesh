import { z } from 'zod';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';

/**
 * UUID validation schema
 */
export const UUIDSchema = z.string().uuid('Invalid UUID format');

/**
 * External UUID schema for Aurora API climb UUIDs (non-standard format without dashes)
 */
export const ExternalUUIDSchema = z.string().min(1, 'UUID cannot be empty').max(50, 'UUID too long');

/**
 * Session ID validation schema
 * Allows UUIDs and alphanumeric strings with hyphens (for testing and backwards compatibility)
 */
export const SessionIdSchema = z
  .string()
  .min(1, 'Session ID cannot be empty')
  .max(100, 'Session ID too long')
  .regex(/^[a-zA-Z0-9-]+$/, 'Session ID must be alphanumeric with hyphens only');

export const ParticipantIdSchema = z
  .string()
  .min(1, 'Participant ID cannot be empty')
  .max(128, 'Participant ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Participant ID must be alphanumeric with hyphens or underscores only');

/**
 * GPS coordinate validation schemas
 */
export const LatitudeSchema = z.number().min(-90, 'Latitude must be >= -90').max(90, 'Latitude must be <= 90');
export const LongitudeSchema = z.number().min(-180, 'Longitude must be >= -180').max(180, 'Longitude must be <= 180');

export const GPSCoordinatesSchema = z.object({
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
});

/**
 * Username validation schema
 */
export const UsernameSchema = z.string().min(1, 'Username cannot be empty').max(50, 'Username too long');

/**
 * Board path validation schema
 */
export const BoardPathSchema = z.string().min(1, 'Board path cannot be empty').max(1000, 'Board path too long');

/**
 * Session name validation schema
 */
export const SessionNameSchema = z.string().max(100, 'Session name too long').optional();

/**
 * Avatar URL validation schema
 */
export const AvatarUrlSchema = z
  .string()
  .max(500, 'Avatar URL too long')
  .refine(
    (url) => url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/'),
    'Avatar URL must use http(s) or be a relative path',
  )
  .optional();

/**
 * Board name validation schema
 */
export const BoardNameSchema = z.enum(SUPPORTED_BOARDS, {
  error: `Board name must be ${SUPPORTED_BOARDS.join(', ')}`,
});

/**
 * Set IDs validation schema. Set IDs travel as a comma-separated list of
 * integers (e.g. "1" or "1,2,3"). The resolvers parse them with
 * `parseInt`/`filter(!isNaN)`, so a non-numeric string like "abc" would slip
 * through `min(1)`, collapse to an empty array, and silently drop the set
 * filter — returning data for the whole board. Enforce the numeric shape here.
 */
export const SetIdsSchema = z.string().regex(/^\d+(,\d+)*$/, 'Set IDs must be comma-separated numbers');

/**
 * Slug validation schema
 */
export const SlugSchema = z
  .string()
  .min(1, 'Slug cannot be empty')
  .max(200, 'Slug too long')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens');

/**
 * Radius validation schema (for nearby sessions)
 */
export const RadiusMetersSchema = z.number().min(100, 'Radius too small').max(50000, 'Radius too large').optional();

/**
 * Queue index validation schema (for reorder operations)
 */
export const QueueIndexSchema = z.number().int('Index must be an integer').min(0, 'Index cannot be negative');

/**
 * Queue item identifier schema (for remove/reorder operations)
 */
export const QueueItemIdSchema = z.string().min(1, 'Queue item ID cannot be empty').max(100, 'Queue item ID too long');

/**
 * Climb UUID schema for resolver inputs. Matches the lenient `ExternalUUIDSchema`
 * shape rather than `UUIDSchema` — Aurora climb UUIDs are not always
 * dash-formatted standard UUIDs (Kilter/Tension store them as compact strings)
 * and the wall-confirm path has to accept whatever the queue item already
 * stores client-side.
 */
export const ClimbUuidSchema = z.string().min(1, 'Climb UUID cannot be empty').max(64, 'Climb UUID too long');

/**
 * BLE board serial schema. The Aurora boards' BLE peripherals advertise a
 * short alphanumeric serial inside the `#…@` segment of the device name
 * (e.g. "Kilter Board#751737@3", "Tension Board#KB-AB12-CD34@3").
 *
 * Tightened from the original `[A-Za-z0-9_:-]{1,64}` regex:
 *  - Minimum length 4. Real Aurora serials are at least four characters; a
 *    one-character serial would never come out of the BLE parser and only
 *    weakens grief-vector defence.
 *  - 32-character cap. Aurora serials are short; the 64-cap was defence
 *    against accidental long strings but went well past anything the
 *    manufacturer would ever ship.
 *  - Underscores removed from the allowed set. The BLE parser at
 *    `bluetooth-aurora.ts:70` extracts whatever sits between `#` and `@` —
 *    Aurora's published serials are alphanumeric with optional dashes (and
 *    occasional colons in multi-segment cases). Underscores never come back
 *    from the parser, so allowing them only widened the surface for malformed
 *    inputs ending up in Redis values.
 */
export const BoardSerialSchema = z
  .string()
  .min(4, 'Board serial too short')
  .max(32, 'Board serial too long')
  .regex(/^[A-Za-z0-9:-]+$/, 'Board serial must be alphanumeric (colon and hyphen allowed)');

/**
 * Validate input and throw a user-friendly error if invalid.
 */
export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown, fieldName?: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
    throw new Error(`Invalid ${fieldName || 'input'}: ${errors}`);
  }
  return result.data;
}
