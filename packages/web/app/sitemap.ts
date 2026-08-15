import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';

type StaticEntry = {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'];
  priority: number;
  /**
   * Hardcoded date the page's content was last meaningfully edited. We don't
   * track this automatically, so update it when you ship a real copy change
   * to the page. Leaving the field unset would also be valid (crawlers fall
   * back to other freshness signals); we set it explicitly so it doesn't
   * lie by claiming "now" on every request.
   */
  lastModified: Date;
};

// Public gym pages (/gym/[slug]) are not listed yet: there is no
// public-gyms enumeration query (only searchGyms/myGyms, both input-driven).
// Tracked follow-up on the gym-kiosk epic — until then gym pages are reached
// through crawlable links from kiosk pages and board pages.
const STATIC_ENTRIES: StaticEntry[] = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0, lastModified: new Date('2026-04-30') },
  { path: '/aurora-migration', changeFrequency: 'weekly', priority: 0.9, lastModified: new Date('2026-04-30') },
  { path: '/about', changeFrequency: 'monthly', priority: 0.8, lastModified: new Date('2026-04-30') },
  { path: '/help', changeFrequency: 'monthly', priority: 0.7, lastModified: new Date('2026-08-15') },
  { path: '/docs', changeFrequency: 'monthly', priority: 0.5, lastModified: new Date('2026-04-30') },
  { path: '/legal', changeFrequency: 'monthly', priority: 0.4, lastModified: new Date('2026-02-08') },
  { path: '/privacy', changeFrequency: 'monthly', priority: 0.4, lastModified: new Date('2026-04-01') },
  { path: '/playlists', changeFrequency: 'weekly', priority: 0.6, lastModified: new Date('2026-04-30') },
];

function buildLanguageMap(path: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const locale of SUPPORTED_LOCALES) {
    languages[locale] = absoluteUrl(localeHref(path, locale));
  }
  languages['x-default'] = absoluteUrl(localeHref(path, DEFAULT_LOCALE));
  return languages;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const result: MetadataRoute.Sitemap = [];

  for (const entry of STATIC_ENTRIES) {
    const languages = buildLanguageMap(entry.path);
    for (const locale of SUPPORTED_LOCALES as readonly Locale[]) {
      result.push({
        url: absoluteUrl(localeHref(entry.path, locale)),
        lastModified: entry.lastModified,
        changeFrequency: entry.changeFrequency,
        priority: entry.priority,
        alternates: { languages },
      });
    }
  }

  return result;
}
