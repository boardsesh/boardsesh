import { sql, type SQL } from 'drizzle-orm';

/** Shared by both search paths and sitemap enumeration. PostgreSQL's range
 * comparison excludes NULL, NaN and infinities as well as invalid coordinates. */
export function gymLocationFilter(
  required: boolean | undefined,
  latitudeColumn: SQL,
  longitudeColumn: SQL,
): SQL | null {
  return required ? sql`${latitudeColumn} BETWEEN -90 AND 90 AND ${longitudeColumn} BETWEEN -180 AND 180` : null;
}
