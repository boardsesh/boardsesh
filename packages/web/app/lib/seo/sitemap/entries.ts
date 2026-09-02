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

/**
 * One `<url>` per item — default locale only, and no `xhtml:link` block.
 *
 * The climb shards' expansion, and a deliberate inconsistency with the boards
 * shard (which does fan out to all four locales). The difference is volume:
 * boards is 690 items → 2,760 URLs; production emits 52,842 climb items, which
 * would fan out to 211,368 locale URLs with a 5-entry alternates block on each.
 * Do not "fix" the inconsistency by fanning climbs out.
 *
 * One of the two reasons for that died with Vercel and one did not, so be clear
 * about which is load-bearing. The byte argument — even one 10,000-item page
 * expands to 40,000 URL entries, past Vercel's 4.5 MB response ceiling — is
 * gone: the container has no such ceiling, and #4648 republished the surface
 * without it. The SEO argument below is the whole reason now, and it is the
 * stronger of the two: fanning out would submit ~158,000 URLs that are not
 * independently indexable pages, against two open issues (#4842, #4861) about
 * what crawl peak already does to the connection pool.
 *
 * The original justification for dropping the sitemap-side hreflang was that
 * `createPageMetadata` emitted `alternates.languages` on both climb-view trees,
 * so the twins carried reciprocal HTML annotations instead. That is no longer
 * why. Board content now goes through `createBoardContentPageMetadata`, which
 * cross-canonicalises the twins onto the default locale and emits **no**
 * `languages` at all — the twins are not separate pages, so there is no cluster
 * to annotate and nothing for the sitemap to list.
 *
 * Still nothing is noindexed: `/es`, `/fr` and `/de` climb pages render and stay
 * reachable through the language switcher. They are simply no longer advertised
 * as independently indexable, which is what a 4x crawl surface was buying us.
 */
export function expandDefaultLocaleOnly(items: readonly SitemapItem[]): SitemapUrlEntry[] {
  return items.map((item) => ({
    loc: absoluteUrl(localeHref(item.path, DEFAULT_LOCALE)),
    lastModified: item.lastModified ?? null,
    changeFrequency: item.changeFrequency,
    priority: item.priority,
  }));
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
