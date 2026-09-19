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
  { path: '/support', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-16') },
  // /help became a hub over seven topic pages once adoption data showed people
  // were missing shipped features rather than asking for new ones.
  { path: '/help', changeFrequency: 'monthly', priority: 0.7, lastModified: new Date('2026-09-19') },
  // Playlists: building one, pruning one, and the eight auto-curated lists.
  { path: '/help/playlists', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Sessions: starting one, sharing the link, and who drives the wall.
  { path: '/help/sessions', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Search: the hold, zone and setter filters almost nobody has found yet.
  { path: '/help/finding-climbs', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Logbook: logging a send, then fixing the grade or rating afterwards.
  { path: '/help/logbook', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Climb actions: about one in five climbers who open a climb have found it.
  { path: '/help/climb-actions', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Beta videos: sharing a clip in, and finding the ones already on a climb.
  { path: '/help/beta-videos', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Bluetooth: the top support topic by error volume.
  {
    path: '/help/board-and-bluetooth',
    changeFrequency: 'monthly',
    priority: 0.6,
    lastModified: new Date('2026-09-19'),
  },
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
