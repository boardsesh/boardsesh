// Timestamp normalization for Postgres columns that carry no offset.
//
// Our tick/ascent columns (`climbed_at`, `created_at`, ...) are declared
// `timestamp without time zone` with Drizzle `mode: 'string'`, so the driver
// hands back a naive `YYYY-MM-DD HH:mm:ss`. The values are UTC by convention,
// but nothing in the string says so — and `new Date()` resolves an unzoned
// string against the *server's* local zone. On any non-UTC host that silently
// shifts every instant we hand to a client.

/**
 * Normalize an offset-less Postgres timestamp to a UTC ISO-8601 string.
 *
 * Stamps a `Z` on anything that isn't already zoned, so a naive
 * `2026-07-03 10:00:00` reads as `2026-07-03T10:00:00.000Z` regardless of the
 * server's `TZ`. `Date` inputs and already-zoned strings pass through as-is;
 * null/undefined/empty, an unparseable string, and an invalid `Date` all yield
 * null so callers can drop the row rather than take a throw. `toISOString()`
 * raises `RangeError` on an invalid instant, and one corrupt row must not fail
 * the whole aggregate.
 */
export function parsePostgresUtcTimestamp(timestamp: string | Date | null | undefined): string | null {
  if (!timestamp) return null;
  if (timestamp instanceof Date) return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
  const isoLikeTimestamp = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T');
  const zonedTimestamp = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoLikeTimestamp) ? isoLikeTimestamp : `${isoLikeTimestamp}Z`;
  const parsed = new Date(zonedTimestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
