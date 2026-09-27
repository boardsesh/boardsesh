/**
 * Parse an HTTP `Retry-After` header into milliseconds from `now`.
 *
 * The header is either a count of seconds (`120`) or an HTTP date. Returns
 * undefined when it is absent or unreadable, and never a negative number: a
 * date in the past means "now". Callers clamp the upper end themselves, since
 * how long a throttle may park work is their decision, not the provider's.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // An HTTP date always names its weekday and month; anything else numeric-ish
  // (`-5`, `1.5`) is garbage, which Date.parse would happily read as a year.
  if (!/[a-z]/i.test(value)) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
