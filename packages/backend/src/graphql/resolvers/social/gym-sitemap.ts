import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { gyms } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { gymLocationFilter } from './gym-discovery-filters';

// Six locale URLs per venue plus directory URLs fit within a 50,000 URL shard.
export const MAX_GYM_SITEMAP_ENTRIES = 7_000;

export async function publicGymSitemap(): Promise<Array<{ slug: string; updatedAt: string }>> {
  const venues = await db
    .select({ slug: gyms.slug, updatedAt: gyms.updatedAt })
    .from(gyms)
    .where(
      and(
        eq(gyms.isPublic, true),
        eq(gyms.isListed, true),
        isNull(gyms.deletedAt),
        isNull(gyms.mergedIntoGymId),
        isNotNull(gyms.slug),
        ne(gyms.slug, ''),
        gymLocationFilter(true, sql`${gyms.latitude}`, sql`${gyms.longitude}`)!,
      ),
    )
    .orderBy(gyms.id)
    .limit(MAX_GYM_SITEMAP_ENTRIES + 1);

  if (venues.length > MAX_GYM_SITEMAP_ENTRIES) {
    throw new Error('Gym sitemap exceeds its venue budget; add pagination before publishing it.');
  }

  return venues.map((venue) => ({ slug: venue.slug!, updatedAt: venue.updatedAt.toISOString() }));
}
