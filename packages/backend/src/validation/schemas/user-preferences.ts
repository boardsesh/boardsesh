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
 * Maximum serialized size of a preference value (bytes of JSON).
 * Preferences are small flags / lookup maps — 8 KB is generous for sensible
 * use and small enough that an authenticated user can't quietly fill the
 * jsonb column with multi-megabyte payloads.
 */
export const MAX_USER_PREFERENCE_VALUE_BYTES = 8 * 1024;

/**
 * Validation for the setUserPreference mutation input.
 * `value` is unknown — callers may store any JSON-serializable payload —
 * but we cap the serialized byte length so this can't be used as a
 * DoS / storage-exhaustion vector by an authenticated client.
 */
export const SetUserPreferenceInputSchema = z.object({
  key: UserPreferenceKeySchema,
  value: z.unknown().refine(
    (value) => {
      try {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string') return false; // e.g. undefined, function
        return Buffer.byteLength(serialized, 'utf8') <= MAX_USER_PREFERENCE_VALUE_BYTES;
      } catch {
        // JSON.stringify throws on circular refs / BigInt — reject.
        return false;
      }
    },
    {
      message: `Preference value must be JSON-serializable and ≤ ${MAX_USER_PREFERENCE_VALUE_BYTES} bytes when serialized`,
    },
  ),
});
