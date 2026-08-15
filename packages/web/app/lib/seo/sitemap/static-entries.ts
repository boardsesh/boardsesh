import type { SitemapItem } from './entries';

/**
 * Hardcoded dates are the page's last meaningful copy edit. We don't track that
 * automatically, so update the date when you ship a real copy change. Leaving
 * `lastModified` unset would also be valid (crawlers fall back to other freshness
 * signals); we set it explicitly so it doesn't lie by claiming "now" every request.
 *
 * Public gym pages (/gym/[slug]) are not listed here — they get their own shard
 * once #4381 lands the public-gyms enumeration query.
 */
export const STATIC_ENTRIES: readonly SitemapItem[] = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0, lastModified: new Date('2026-04-30') },
  { path: '/aurora-migration', changeFrequency: 'weekly', priority: 0.9, lastModified: new Date('2026-04-30') },
  { path: '/about', changeFrequency: 'monthly', priority: 0.8, lastModified: new Date('2026-04-30') },
  // /help was rewritten text-first when W-16 removed the interactive climbing UI.
  { path: '/help', changeFrequency: 'monthly', priority: 0.7, lastModified: new Date('2026-08-15') },
  // /docs lost both Aurora proxy operations (plus the tag, the overview bullet and
  // three schemas) when W-25a deprecated them, then lost the "Retired endpoints"
  // card itself when W-25b deleted the URLs outright (410 -> 404).
  { path: '/docs', changeFrequency: 'monthly', priority: 0.5, lastModified: new Date('2026-08-19') },
  { path: '/legal', changeFrequency: 'monthly', priority: 0.4, lastModified: new Date('2026-02-08') },
  { path: '/privacy', changeFrequency: 'monthly', priority: 0.4, lastModified: new Date('2026-04-01') },
  { path: '/playlists', changeFrequency: 'weekly', priority: 0.6, lastModified: new Date('2026-04-30') },
];

/** A copy: a caller that sorts or splices the result must not rewrite the constant. */
export function buildStaticEntries(): SitemapItem[] {
  return [...STATIC_ENTRIES];
}
