import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import type { ChangeFrequency, SitemapUrlEntry } from './sitemap-xml';

/**
 * One sitemapped page, locale-agnostic. `expandLocales` is the single place a
 * item fans out into one `<url>` per locale, so every shard emits the identical
 * hreflang block and Search Console's "return links" check holds by construction.
 */
export type SitemapItem = {
  /** Root-relative, unprefixed path — e.g. `/about`, not `/es/about`. */
  path: string;
  /**
   * Real content timestamp, or null when the surface genuinely has none.
   * Never synthesise one: a `new Date()` here claims every page changed on
   * every crawl and destroys the signal.
   */
  lastModified?: Date | null;
  changeFrequency?: ChangeFrequency;
  priority?: number;
};

/**
 * One documented exemption from "the sitemap and the page emit one identical
 * string": `absoluteUrl('/')` returns the bare `https://www.boardsesh.com`,
 * while the homepage's own canonical is the relative `/` that Next resolves
 * against `metadataBase` into `.../`. Crawlers normalise an empty HTTP path to
 * `/`, so they are the same URL; the deleted `app/sitemap.ts` emitted the same
 * bare form, and `absoluteUrl` is shared with the canonical/OG helpers
 * site-wide, so it is left alone rather than changed underneath them.
 */

/** hreflang code → absolute URL, identical for every locale variant of one item. */
export function buildAlternates(path: string): Record<string, string> {
  const alternates: Record<string, string> = {};
  for (const locale of SUPPORTED_LOCALES) {
    alternates[locale] = absoluteUrl(localeHref(path, locale));
  }
  alternates['x-default'] = absoluteUrl(localeHref(path, DEFAULT_LOCALE));
  return alternates;
}

export function expandLocales(item: SitemapItem): SitemapUrlEntry[] {
  const alternates = buildAlternates(item.path);

  return SUPPORTED_LOCALES.map((locale) => ({
    loc: absoluteUrl(localeHref(item.path, locale)),
    lastModified: item.lastModified ?? null,
    changeFrequency: item.changeFrequency,
    priority: item.priority,
    alternates,
  }));
}

export function expandAllLocales(items: readonly SitemapItem[]): SitemapUrlEntry[] {
  return items.flatMap((item) => expandLocales(item));
}

/**
 * How many `<url>` entries `expandAllLocales` would produce, without building
 * them. The index checks every shard against the URL budget on a `force-dynamic`
 * route, and materialising up to 45,000 entries — each carrying a five-key
 * alternates record — only to read `.length` turns a guard into a cost.
 * `expandLocales` emits exactly one entry per supported locale for every item,
 * which is what makes this arithmetic exact rather than an estimate; a unit test
 * pins the two against each other so a future expansion rule cannot drift.
 */
export function allLocalesUrlCount(items: readonly SitemapItem[]): number {
  return items.length * SUPPORTED_LOCALES.length;
}

/** Newest real timestamp across a shard's items, or null when none carries one. */
export function latestLastModified(items: readonly SitemapItem[]): Date | null {
  let latest: Date | null = null;
  for (const item of items) {
    if (!item.lastModified) continue;
    if (!latest || item.lastModified > latest) {
      latest = item.lastModified;
    }
  }
  return latest;
}
