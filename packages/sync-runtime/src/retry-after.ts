/**
 * The longest delay the parser reports: 30 days. It exists to keep the result
 * finite and safe to add to a timestamp; callers apply their own, lower cap.
 */
export const RETRY_AFTER_PARSE_CEILING_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Parse an HTTP `Retry-After` header into milliseconds from `now`.
 *
 * The header is either a count of seconds (`120`) or an HTTP date. Returns
 * undefined when it is absent or unreadable, and never a negative number: a
 * date in the past means "now". Callers clamp the upper end themselves, since
 * how long a throttle may park work is their decision, not the provider's.
 * The parser still bounds its result at {@link RETRY_AFTER_PARSE_CEILING_MS}
 * so a header of twenty nines stays a finite number of milliseconds.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) {
    // Cap before returning: `Number('9'.repeat(20)) * 1000` is past
    // MAX_SAFE_INTEGER, and a long enough string makes Number() Infinity.
    // The product is only compared against the ceiling, never returned when
    // it exceeds it.
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds * 1000 > RETRY_AFTER_PARSE_CEILING_MS) return RETRY_AFTER_PARSE_CEILING_MS;
    return seconds * 1000;
  }
  // An HTTP date always names its weekday and month; anything else numeric-ish
  // (`-5`, `1.5`) is garbage, which Date.parse would happily read as a year.
  if (!/[a-z]/i.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(RETRY_AFTER_PARSE_CEILING_MS, Math.max(0, at - now));
}
