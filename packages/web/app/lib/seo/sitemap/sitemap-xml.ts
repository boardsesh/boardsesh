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
