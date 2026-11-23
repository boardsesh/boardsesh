import { developerDocsIndexable } from '@/app/lib/developer-apps/docs-access';
import type { SitemapItem } from './entries';
import { GUIDE_SLUGS } from '@/app/developers/guide-documents';

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
  { path: '/boards', changeFrequency: 'monthly', priority: 0.9, lastModified: new Date('2026-11-23') },
  { path: '/spraywalls', changeFrequency: 'monthly', priority: 0.9, lastModified: new Date('2026-11-23') },
  { path: '/spraywalls/find', changeFrequency: 'weekly', priority: 0.8, lastModified: new Date('2026-11-23') },
  { path: '/for-gyms', changeFrequency: 'monthly', priority: 0.8, lastModified: new Date('2026-11-18') },
  { path: '/', changeFrequency: 'weekly', priority: 1.0, lastModified: new Date('2026-10-06') },
  { path: '/bring-your-logbook', changeFrequency: 'weekly', priority: 0.9, lastModified: new Date('2026-11-18') },
  { path: '/about', changeFrequency: 'monthly', priority: 0.8, lastModified: new Date('2026-04-30') },
  { path: '/support', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-16') },
  // /help became a hub over its topic pages once adoption data showed people
  // were missing shipped features rather than asking for new ones.
  { path: '/help', changeFrequency: 'monthly', priority: 0.7, lastModified: new Date('2026-09-19') },
  // Sessions: starting one, sharing the link, and who drives the wall.
  { path: '/help/sessions', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Find, play and save climbs: swiping a list, the press-and-hold menu, filters and playlists.
  { path: '/help/finding-climbs', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-11-03') },
  // Logbook: logging a send, then fixing the grade or rating afterwards.
  { path: '/help/logbook', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-09-19') },
  // Bluetooth: the top support topic by error volume.
  {
    path: '/help/board-and-bluetooth',
    changeFrequency: 'monthly',
    priority: 0.6,
    lastModified: new Date('2026-09-19'),
  },
  // Spray walls: shooting the photo the hold finder reads, then fixing its holds.
  { path: '/help/spray-walls', changeFrequency: 'monthly', priority: 0.6, lastModified: new Date('2026-10-09') },
  // /docs lost both Aurora proxy operations (plus the tag, the overview bullet and
  // three schemas) when W-25a deprecated them, then lost the "Retired endpoints"
  // card itself when W-25b deleted the URLs outright (410 -> 404).
  { path: '/docs', changeFrequency: 'monthly', priority: 0.5, lastModified: new Date('2026-08-19') },
  { path: '/legal', changeFrequency: 'monthly', priority: 0.4, lastModified: new Date('2026-02-08') },
  { path: '/privacy', changeFrequency: 'monthly', priority: 0.4, lastModified: new Date('2026-04-01') },
  { path: '/playlists', changeFrequency: 'weekly', priority: 0.6, lastModified: new Date('2026-04-30') },
];

/**
 * The developer docs (docs/integrations/partner-api.md made public). Listed only while
 * PARTNER_OAUTH_MODE is `open`, the one state the page itself is indexable in;
 * `off`, `hold` and `allowlist` serve a 404 or a noindex page, and a sitemap
 * must never advertise either. The shard is `force-dynamic`, so the mode is
 * read per request.
 */
export const DEVELOPER_DOCS_ENTRY: SitemapItem = {
  path: '/developers',
  changeFrequency: 'monthly',
  priority: 0.5,
  lastModified: new Date('2026-11-17'),
};

/** A copy: a caller that sorts or splices the result must not rewrite the constant. */
export function buildStaticEntries(): SitemapItem[] {
  return developerDocsIndexable()
    ? [
        ...STATIC_ENTRIES,
        DEVELOPER_DOCS_ENTRY,
        ...GUIDE_SLUGS.map((slug) => ({ ...DEVELOPER_DOCS_ENTRY, path: `/developers/${slug}` })),
      ]
    : [...STATIC_ENTRIES];
}
