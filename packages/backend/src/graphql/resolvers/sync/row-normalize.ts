// Row shaping shared by the offline-sync pull resolvers (sync/queries.ts) and
// the nightly snapshot export job (scripts/export-board-snapshots.ts). Kept in
// its own module so both paths coerce a raw postgres-js row into a sync document
// identically — the export artifact and a live pull must produce byte-identical
// SQLite rows. See docs/sync-table-manifest.md.

export type RawRow = Record<string, unknown>;

// postgres.js returns `timestamp` (without time zone) columns as
// 'YYYY-MM-DD HH:MM:SS[.ffffff]' strings — drizzle's postgres-js driver installs
// passthrough parsers for the timestamp/date OIDs, so both the resolvers and any
// consumer of the same drizzle-constructed client see this shape.
export const PG_TIMESTAMP_TEXT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Convert a raw postgres-js row into a sync document. The manifest pins every
 * timestamp to ISO-8601 TEXT on the client, but drizzle's postgres-js driver
 * returns `timestamp` columns as 'YYYY-MM-DD HH:MM:SS[.ffffff]' STRINGS (it
 * registers passthrough parsers for OIDs 1114/1184), so both shapes are
 * normalized here — a Date via toISOString, a pg-text timestamp via toIso.
 * Without the string branch, pulled rows and offline-written local rows would
 * mix formats in the same SQLite TEXT column, breaking ordering and the
 * tombstone resurrection guard. int[] columns stay as JS arrays (the mobile
 * upsert JSON-stringifies them); bigint columns stay as-is.
 */
export function normalizeRow(row: RawRow): RawRow {
  const out: RawRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (typeof value === 'string' && PG_TIMESTAMP_TEXT.test(value)) {
      out[key] = toIso(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  // postgres.js returns `timestamp` (without time zone) columns as
  // 'YYYY-MM-DD HH:MM:SS[.ffffff]' strings. Normalize textually to ISO-8601
  // UTC ('T' separator, trailing 'Z') — these columns are written by now() in
  // UTC — instead of round-tripping through Date, which would apply the
  // process timezone and clamp microsecond precision. The `::timestamp` cast
  // on cursor replay ignores the 'Z', so the value round-trips losslessly.
  const stringValue = String(value);
  const timestampMatch = PG_TIMESTAMP_TEXT.exec(stringValue);
  if (timestampMatch) return `${timestampMatch[1]}T${timestampMatch[2]}Z`;
  return stringValue;
}
