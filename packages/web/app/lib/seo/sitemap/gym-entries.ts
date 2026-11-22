import { gymDirectoryIndexingEnabled } from '../gym-directory-indexing';
import { FACET_BASE_PATHS } from '@/app/gyms/directory-facets';
import type { SitemapItem } from './entries';

/** Publish directory routes and eligible canonical venues in one rollout. */
export async function buildGymEntries(): Promise<SitemapItem[]> {
  if (!gymDirectoryIndexingEnabled()) return [];

  // Load the transport only when enabled; a disabled rollout makes no request.
  const { fetchGymSitemapRows } = await import('./gym-query');
  const gyms = await fetchGymSitemapRows();
  const entries: SitemapItem[] = Object.values(FACET_BASE_PATHS).map((path) => ({
    path,
    changeFrequency: 'weekly',
    priority: 0.7,
  }));
  const slugs = new Set<string>();
  for (const gym of gyms) {
    const updatedAt = new Date(gym.updatedAt);
    if (!gym.slug.trim() || Number.isNaN(updatedAt.getTime()) || slugs.has(gym.slug)) {
      throw new Error('Invalid or duplicate gym sitemap row');
    }
    slugs.add(gym.slug);
    entries.push({
      path: `/gym/${encodeURIComponent(gym.slug)}`,
      lastModified: updatedAt,
      changeFrequency: 'weekly',
      priority: 0.6,
    });
  }
  return entries;
}
