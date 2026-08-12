// Parsing pending_mutations.created_at back into an epoch.
//
// The column defaults to SQLite `datetime('now')` (see mutation-queue/schema.ts),
// which produces UTC in the form 'YYYY-MM-DD HH:MM:SS' — a SPACE separator and
// no zone designator. That is NOT ISO-8601, so `Date.parse` on it is
// implementation-defined: V8 accepts it (a Node-only test would pass), Hermes is
// stricter, and the device would silently return null forever while the metric
// read as "no data" instead of "bug". Normalising the separator and stamping the
// zone is what makes the same string parse identically on both engines.

/**
 * Parse a `pending_mutations.created_at` value into epoch milliseconds.
 * Returns null for anything unparseable — callers must treat a null age as
 * "unknown", never as zero.
 */
export function parseQueueTimestamp(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;
  const trimmed = createdAt.trim();
  if (trimmed.length === 0) return null;

  // Already carries a zone (or an offset) — pass it through untouched.
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = hasZone ? trimmed.replace(' ', 'T') : `${trimmed.replace(' ', 'T')}Z`;

  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whole days between a queue timestamp and `now`, floored. Null when the
 * timestamp can't be parsed, so a missing value never renders as "0 days old".
 */
export function queueTimestampAgeDays(createdAt: string | null | undefined, now: number = Date.now()): number | null {
  const parsed = parseQueueTimestamp(createdAt);
  if (parsed === null) return null;
  return Math.floor((now - parsed) / 86_400_000);
}
