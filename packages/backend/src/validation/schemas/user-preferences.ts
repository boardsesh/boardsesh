import { z } from 'zod';

/**
 * Allowed pattern for user preference keys.
 * - Must start with an ASCII letter
 * - May contain ASCII letters, digits, colon, underscore, hyphen
 * - Max 64 characters
 *
 * Colon is permitted so callers can namespace keys (e.g. 'consent:analytics').
 */
const USER_PREFERENCE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9:_-]{0,63}$/;

export const UserPreferenceKeySchema = z
  .string()
  .regex(USER_PREFERENCE_KEY_PATTERN, 'Preference key must match /^[a-zA-Z][a-zA-Z0-9:_-]{0,63}$/');

/**
 * Validation for the setUserPreference mutation input.
 * `value` is intentionally unknown — callers may store any JSON-serializable
 * payload. Resolvers and the DB jsonb column handle the rest.
 */
export const SetUserPreferenceInputSchema = z.object({
  key: UserPreferenceKeySchema,
  value: z.unknown(),
});
