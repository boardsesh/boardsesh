import { and, desc, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ConnectionContext, PlaceSuggestion } from '@boardsesh/shared-schema';
import { places } from '@boardsesh/db/schema';
import { normalizePlaceSearch } from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { applyRateLimit } from '../shared/helpers';

const placeQuerySchema = z.string().trim().min(3).max(80);

export const placeQueries = {
  searchPlaces: async (
    _: unknown,
    { query }: { query: string },
    ctx: ConnectionContext,
  ): Promise<PlaceSuggestion[]> => {
    await applyRateLimit(ctx, 120, 'searchPlaces');
    const normalizedQuery = normalizePlaceSearch(placeQuerySchema.parse(query));
    if (normalizedQuery.length < 3) return [];
    // Normalization strips LIKE metacharacters. Every token must match, allowing
    // qualifiers such as "Sydney Australia" and aliases such as "Munchen".
    return db
      .select({
        id: places.id,
        name: places.name,
        region: places.region,
        country: places.country,
        countryCode: places.countryCode,
        latitude: places.latitude,
        longitude: places.longitude,
      })
      .from(places)
      .where(
        and(
          ...normalizedQuery
            .split(' ')
            .filter(Boolean)
            .map((token) => like(places.searchText, `%${token}%`)),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${eq(places.normalizedName, normalizedQuery)} THEN 0 WHEN ${like(places.normalizedName, `${normalizedQuery}%`)} THEN 1 ELSE 2 END`,
        desc(places.population),
        places.id,
      )
      .limit(5);
  },
};
