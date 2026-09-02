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
 * Hard stop on a PAGED shard page, enforced on the RENDERED BODY rather than on
 * a row count — a constant alone is a comment, and a URL count cannot see how
 * expensive one URL is.
 *
 * The old 4 MB was Vercel's 4.5 MB serverless response ceiling with headroom.
 * Off Vercel (#4648) the outer authority is sitemaps.org: 50 MB uncompressed per
 * file, above which Search Console rejects the shard whole.
 *
 * 12 MB is the largest body a paged shard can *intend* to serve at the two
 * per-URL costs this site actually renders, measured on www on 2026-09-02:
 *
 * - **~250 bytes**, `default-locale-only` with no alternates block — what the
 *   climbs pages cost. `MAX_URLS_PER_SHARD` (45,000) of those is ~11 MB.
 * - **866 bytes**, `all-locales` with the five-entry hreflang block —
 *   `/sitemaps/playlists.xml` is 2,615,676 bytes across 3,020 `<url>` entries.
 *   A paged shard on that expansion trips this at ~13,850 URLs, which is the
 *   right answer: it has to page smaller, not render a 39 MB file.
 *
 * So the guard fires on a page whose rendered body ran several times past what
 * its row budget predicted, and no longer 503s a legitimately large one for a
 * platform we left.
 */
export const MAX_SHARD_BYTES = 12_000_000;

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
