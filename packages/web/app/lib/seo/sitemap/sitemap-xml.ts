import { SUPPORTED_LOCALES } from '@/app/lib/i18n/config';

/**
 * Search engines reject a sitemap file over 50,000 URLs (or 50MB uncompressed).
 * We shard at 45k to leave headroom before the hard limit — a shard that grows
 * past its budget must split, never truncate.
 */
export const MAX_URLS_PER_SHARD = 45_000;

/**
 * Every item is emitted once per locale, so the *item* budget is the URL budget
 * divided by the locale count. With four locales that is 11,250 items/shard.
 */
export const MAX_ITEMS_PER_SHARD = Math.floor(MAX_URLS_PER_SHARD / SUPPORTED_LOCALES.length);

/**
 * Page size for the climbs shard. It used to be a byte ceiling in disguise:
 * 45,000 climb URLs render ~11 MB at our path lengths (`/kilter/original/
 * 12x12-square/screw_bolt/40/view/{slug}-{uuid}` plus the `<lastmod>`, ~250
 * bytes each), which Vercel truncated or 500'd at its 4.5 MB serverless
 * response ceiling. www serves from a Railway container now (#4648), so that
 * ceiling is gone and nothing forces this below the protocol's 45,000.
 *
 * It stays at 10,000 anyway, for two reasons that have nothing to do with a
 * platform:
 *
 * - **`<lastmod>` granularity.** `fetchStoredClimbPageLastmods` gives each page
 *   its own `max(last_modified)` so one stats update no longer makes the whole
 *   surface look changed (#4552). Six pages localise that to a sixth of the
 *   catalogue; two pages of 45,000 would put half of it back in play on every
 *   refresh, which is exactly the re-crawl volume #4842/#4861 are open about.
 * - **Bounded work per request.** A page is one ordinal-range read plus one
 *   rendered string held whole in memory. At 10,000 rows that is ~21 ms and
 *   ~2.5 MB on a container whose RSS the deploy runbook watches; at 45,000 it
 *   is four and a half times both.
 *
 * Raising it is a deliberate change with a crawl-shape argument behind it, not
 * a leftover to clean up.
 */
export const CLIMB_URLS_PER_SHARD = 10_000;

/**
 * Hard stop on ANY sitemap file, fixed or paged, enforced on the RENDERED BODY
 * rather than on a row count — a constant alone is a comment, and a URL count
 * cannot see how expensive one URL is.
 *
 * The old 4 MB was Vercel's 4.5 MB serverless response ceiling with headroom, and
 * it was applied only on the paged path (#4618). Off Vercel (#4648) the platform
 * ceiling is gone and the outer authority is the protocol: sitemaps.org rejects a
 * file over 50 MB uncompressed, and Search Console rejects it whole rather than
 * truncating, so serving one is strictly worse than serving nothing. 45 MB is
 * that limit with the same 10% headroom `MAX_URLS_PER_SHARD` keeps against
 * 50,000 URLs, and both handlers enforce it now.
 *
 * It is a *backstop*, not the working guard, and at today's costs it does not
 * bind: measured on www on 2026-09-02, `/sitemaps/playlists.xml` renders 866
 * bytes per URL (2,615,676 bytes across 3,020 `<url>` entries — an `all-locales`
 * shard dominated by the five-entry `xhtml:link` block), so the worst body
 * `MAX_URLS_PER_SHARD` permits is ~39 MB. This fires above ~1,000 B/URL, i.e.
 * when a per-URL cost grew rather than when a shard did.
 *
 * A paged shard gets a tighter, page-sized budget on top — see
 * {@link pagedShardByteBudget}. A 39 MB fixed shard is legal but still far more
 * file than anyone should hand a crawler; paging `playlists` is tracked in
 * #5073.
 */
export const MAX_SHARD_BYTES = 45_000_000;

/**
 * Bytes per URL a PAGED shard page may average before its own guard fires.
 *
 * `MAX_SHARD_BYTES` cannot do this job: it is sized to the protocol, and the only
 * paged shard configured today renders 10,000 URLs at ~250 bytes each — ~2.5 MB,
 * eighteen times under it. A ceiling that far above the page it guards cannot see
 * the regression that matters, which is a per-URL cost that multiplied. Fanning
 * the climbs pages out to locales would do exactly that: it adds the hreflang
 * alternates block `entries.ts` warns against, taking each URL from ~250 B to the
 * 866 B measured on `/sitemaps/playlists.xml` and a page from 2.5 MB to 8.7 MB.
 *
 * 500 is double the measured cost and well under the fanned-out one, so a page
 * that grew legitimately long paths still serves and that regression still 503s.
 */
const PAGED_SHARD_BYTES_PER_URL = 500;

/**
 * The byte budget for one page of a paged shard: its own page size at
 * {@link PAGED_SHARD_BYTES_PER_URL}, never above the protocol backstop.
 *
 * Derived from `urlsPerShard` rather than pinned as a constant so the number
 * tracks the page it guards — a shard that halves its page size halves its byte
 * budget instead of keeping a ceiling sized for the old one.
 */
export function pagedShardByteBudget(urlsPerShard: number): number {
  return Math.min(urlsPerShard * PAGED_SHARD_BYTES_PER_URL, MAX_SHARD_BYTES);
}

export type ChangeFrequency = 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

export type SitemapUrlEntry = {
  loc: string;
  /** Omitted from the XML when null/undefined — we never synthesise "now". */
  lastModified?: Date | null;
  changeFrequency?: ChangeFrequency;
  priority?: number;
  /** hreflang code → absolute URL. Rendered as `<xhtml:link rel="alternate">`. */
  alternates?: Record<string, string>;
};

export type SitemapIndexEntry = {
  loc: string;
  lastModified?: Date | null;
};

/**
 * Setter usernames and playlist names are user-controlled and end up inside
 * `<loc>` and hreflang `href` attributes. One unescaped `&` makes Search Console
 * reject the whole shard, so nothing is interpolated without going through here.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderLastMod(lastModified: Date | null | undefined): string {
  if (!lastModified) {
    return '';
  }
  return `\n    <lastmod>${lastModified.toISOString()}</lastmod>`;
}

function renderAlternates(alternates: Record<string, string> | undefined): string {
  if (!alternates) {
    return '';
  }
  return Object.entries(alternates)
    .map(
      ([hreflang, href]) =>
        `\n    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(href)}" />`,
    )
    .join('');
}

export function renderUrlset(entries: readonly SitemapUrlEntry[]): string {
  const needsXhtmlNamespace = entries.some((entry) => entry.alternates && Object.keys(entry.alternates).length > 0);
  const xhtmlNamespace = needsXhtmlNamespace ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';

  const body = entries
    .map((entry) => {
      const changeFrequency = entry.changeFrequency ? `\n    <changefreq>${entry.changeFrequency}</changefreq>` : '';
      const priority = entry.priority === undefined ? '' : `\n    <priority>${entry.priority.toFixed(1)}</priority>`;
      return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${renderLastMod(entry.lastModified)}${changeFrequency}${priority}${renderAlternates(entry.alternates)}\n  </url>`;
    })
    .join('\n');

  return joinXmlDocument(
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtmlNamespace}>`,
    body,
    '</urlset>',
  );
}

/** Skips the body line entirely when a shard is empty, so `<urlset></urlset>` has no stray blank line. */
function joinXmlDocument(declaration: string, openTag: string, body: string, closeTag: string): string {
  const lines = body ? [declaration, openTag, body, closeTag] : [declaration, openTag, closeTag];
  return `${lines.join('\n')}\n`;
}

export function renderSitemapIndex(shards: readonly SitemapIndexEntry[]): string {
  const body = shards
    .map(
      (shard) =>
        `  <sitemap>\n    <loc>${escapeXml(shard.loc)}</loc>${renderLastMod(shard.lastModified)}\n  </sitemap>`,
    )
    .join('\n');

  return joinXmlDocument(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    '</sitemapindex>',
  );
}
