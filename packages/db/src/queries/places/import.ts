import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { places, placeImports } from '../../schema/app/places';

export const PLACE_DATASET = 'geonames-cities500-v1';

/** Metadata and all batches commit together; a failed refresh preserves the old index. */
export async function importPlaceRows(
  db: PostgresJsDatabase<Record<string, unknown>>,
  rows: Array<typeof places.$inferInsert>,
  sources: (typeof placeImports.$inferInsert)['sources'],
  ifEmpty = false,
): Promise<void> {
  await db.transaction(async (transaction) => {
    // Concurrent deployments must not interleave two versions of the index.
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(718024, 1)`);
    if (ifEmpty) {
      const [completedImport] = await transaction
        .select()
        .from(placeImports)
        .where(eq(placeImports.dataset, PLACE_DATASET))
        .limit(1);
      if (completedImport) return;
    }
    for (let offset = 0; offset < rows.length; offset += 1000) {
      await transaction
        .insert(places)
        .values(rows.slice(offset, offset + 1000))
        .onConflictDoUpdate({
          target: places.id,
          set: {
            name: sql`excluded.name`,
            normalizedName: sql`excluded.normalized_name`,
            countryCode: sql`excluded.country_code`,
            country: sql`excluded.country`,
            region: sql`excluded.region`,
            latitude: sql`excluded.latitude`,
            longitude: sql`excluded.longitude`,
            population: sql`excluded.population`,
            searchText: sql`excluded.search_text`,
          },
        });
    }
    await transaction
      .insert(placeImports)
      .values({ dataset: PLACE_DATASET, rowCount: rows.length, sources })
      .onConflictDoUpdate({
        target: placeImports.dataset,
        set: { importedAt: new Date(), rowCount: rows.length, sources },
      });
  });
}
