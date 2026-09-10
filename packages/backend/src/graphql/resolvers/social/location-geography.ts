import { sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';

export type LocationGeographyTable = 'user_boards' | 'gyms';

type SyncLocationGeographyArgs = {
  table: LocationGeographyTable;
  id: number;
  latitude: number | null;
  longitude: number | null;
  /** Resolver name, for log correlation. */
  operation: string;
};

/**
 * Populate (or clear) the PostGIS `location` column for a gym or board row.
 *
 * These columns are denormalizations used by proximity search. The write runs
 * outside the caller's transaction and never throws: inside a transaction a
 * PostGIS failure (the extension can be missing on any self-hosted deployment,
 * and the backend test DB skips it too when its server has no PostGIS package)
 * rolled the whole thing back and silently cost the user their gym. Out here the
 * worst case is
 * a null `location` that a backfill can repair — the row id is logged so that
 * backfill is a one-liner.
 *
 * On a migrated PostGIS database this write is a backstop anyway: migration
 * 0127 installs `gyms_set_location` / `user_boards_set_location` BEFORE INSERT
 * OR UPDATE OF latitude, longitude triggers that already derive the geography
 * from the lat/lng columns, so failing this statement is never load-bearing.
 */
export async function syncLocationGeography({
  table,
  id,
  latitude,
  longitude,
  operation,
}: SyncLocationGeographyArgs): Promise<void> {
  const hasCoordinates = latitude != null && longitude != null;

  try {
    // The table name is never interpolated — each branch is a hard-coded
    // statement so no caller can steer the SQL.
    if (table === 'gyms') {
      await db.execute(
        hasCoordinates
          ? sql`UPDATE gyms SET location = ST_MakePoint(${longitude}, ${latitude})::geography WHERE id = ${id}`
          : sql`UPDATE gyms SET location = NULL WHERE id = ${id}`,
      );
    } else {
      await db.execute(
        hasCoordinates
          ? sql`UPDATE user_boards SET location = ST_MakePoint(${longitude}, ${latitude})::geography WHERE id = ${id}`
          : sql`UPDATE user_boards SET location = NULL WHERE id = ${id}`,
      );
    }
  } catch (error) {
    logger.warn('Failed to sync location geography; leaving the column as-is', {
      table,
      id,
      operation,
      code: getPostgresErrorCode(error),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
