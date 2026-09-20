import { bigint, doublePrecision, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Local GeoNames gazetteer. Independent of gym ownership and location sync. */
export const places = pgTable(
  'places',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    countryCode: text('country_code').notNull(),
    country: text('country').notNull(),
    region: text('region').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    population: bigint('population', { mode: 'number' }).notNull(),
    searchText: text('search_text').notNull(),
  },
  (table) => [index('places_search_text_idx').using('gin', table.searchText.op('gin_trgm_ops'))],
);

export const placeImports = pgTable('place_imports', {
  dataset: text('dataset').primaryKey(),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
  rowCount: integer('row_count').notNull(),
  sources: jsonb('sources').$type<Array<{ name: string; sha256: string; modifiedAt: string | null }>>().notNull(),
});
