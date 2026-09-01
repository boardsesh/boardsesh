import type { Metadata } from 'next';
import { DEFAULT_LOCALE, LOCALE_OG, SUPPORTED_LOCALES, type Locale } from '@/app/lib/i18n/config';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { absoluteUrl } from './base-url';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './og';

export const SITE_NAME = 'Boardsesh';
export const DEFAULT_OG_IMAGE_PATH = '/opengraph-image';

type PageMetadataOptions = {
  title: string;
  description: string;
  ogDescription?: string;
  path?: string;
  imagePath?: string | null;
  imageAlt?: string;
  // `null` means "emit no dimension": correct for a user-uploaded image whose
  // aspect ratio we don't know. Lying about it makes the scraper crop or letterbox.
  imageWidth?: number | null;
  imageHeight?: number | null;
  robots?: Metadata['robots'];
  keywords?: string[];
  openGraphType?: 'website' | 'article' | 'profile';
  twitterCard?: 'summary' | 'summary_large_image' | 'app' | 'player';
  locale?: Locale;
};

function normalizePath(path?: string): string | undefined {
  if (!path) {
    return undefined;
  }

  // Absolute URLs (e.g. the backend-hosted OG image) pass through untouched —
  // prefixing a slash would mangle them into `/https://…`.
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  if (path === '/') {
    return '/';
  }

  return path.startsWith('/') ? path : `/${path}`;
}

export function withBrandTitle(title: string): string {
  if (/\|\s*Boardsesh$/i.test(title) || /^Boardsesh\b/.test(title)) {
    return title;
  }

  return `${title} | ${SITE_NAME}`;
}

function buildLanguageAlternates(basePath: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const locale of SUPPORTED_LOCALES) {
    languages[locale] = localeHref(basePath, locale);
  }
  languages['x-default'] = localeHref(basePath, DEFAULT_LOCALE);
  return languages;
}

export function createPageMetadata({
  title,
  description,
  ogDescription,
  path,
  imagePath = DEFAULT_OG_IMAGE_PATH,
  imageAlt,
  imageWidth = OG_IMAGE_WIDTH,
  imageHeight = OG_IMAGE_HEIGHT,
  robots,
  keywords,
  openGraphType = 'website',
  twitterCard = 'summary_large_image',
  locale = DEFAULT_LOCALE,
}: PageMetadataOptions): Metadata {
  const basePath = normalizePath(path);
  const canonicalPath = basePath ? localeHref(basePath, locale) : undefined;
  const fullTitle = withBrandTitle(title);
  const normalizedImagePath = imagePath ? normalizePath(imagePath) : undefined;
  const alternates: Metadata['alternates'] = basePath
    ? {
        canonical: canonicalPath,
        languages: buildLanguageAlternates(basePath),
      }
    : undefined;

  return {
    // `absolute`, not a bare string. The root layout sets
    // `title.template = '%s | Boardsesh'` (app/layout.tsx), and Next applies that
    // template to any descendant whose title is a plain string. `fullTitle`
    // already carries the suffix, so a plain string here renders
    // `… | Boardsesh | Boardsesh` — which is exactly what production served on
    // every page outside the board tree until #4472.
    //
    // The board tree escaped only by accident: its
    // `[board_name]/…/[angle]/layout.tsx` exports its own `generateMetadata`
    // returning a plain `title` string, which consumes the inherited template
    // before `/list` and `/view/[climb_uuid]` ever see it. Do not rely on that —
    // `absolute` makes the outcome the same in both trees.
    //
    // `openGraph.title` and `twitter.title` below are already immune: Next never
    // applies the template to them, which is why they were correct in production
    // while `<title>` — the one Google renders in the SERP — was not.
    title: { absolute: fullTitle },
    description,
    alternates,
    robots,
    keywords,
    openGraph: {
      title: fullTitle,
      description: ogDescription ?? description,
      type: openGraphType,
      url: canonicalPath,
      siteName: SITE_NAME,
      locale: LOCALE_OG[locale],
      images: normalizedImagePath
        ? [
            {
              url: normalizedImagePath,
              alt: imageAlt ?? fullTitle,
              ...(imageWidth === null ? {} : { width: imageWidth }),
              ...(imageHeight === null ? {} : { height: imageHeight }),
            },
          ]
        : undefined,
    },
    twitter: {
      card: twitterCard,
      title: fullTitle,
      description,
      images: normalizedImagePath ? [normalizedImagePath] : undefined,
    },
  };
}

/**
 * Metadata for the board-content surfaces — climb view, climb list, setter — in
 * BOTH route trees.
 *
 * These differ from every other page in one way that matters to a crawler: the
 * locale twins are translated *chrome* over identical *content*. The climb name,
 * grade, setter, ascent count and board art are identical in `/de`, `/es` and
 * `/fr`; only UI strings differ. So the four URLs are one page, and saying
 * otherwise cost us a 4x crawl surface.
 *
 * Measured 2026-08-27: ~205k climb-view renders/day with Postgres at 183/200
 * connections (180 idle, 2 active), while 14 of the 18 climb URLs in a top-25
 * sample carried a locale prefix. Disabling the climb sitemaps did not help,
 * because the twins were never advertised from the sitemap — they were
 * advertised by every page's own `hreflang` block, which hands a crawler three
 * more URLs each time it fetches one.
 *
 * Two departures from `createPageMetadata`, and they only work as a pair:
 *
 * 1. **Canonical points at the default-locale URL**, not the served one.
 * 2. **No `alternates.languages`.** Canonical alone would not have worked:
 *    Googlebot must still fetch `/de/…` to read the canonical, and the
 *    `hreflang` block would go on advertising the twins regardless. Google also
 *    requires members of an `hreflang` cluster to self-canonicalise, so keeping
 *    both ships a contradiction it resolves by ignoring the cluster.
 *
 * `og:locale` deliberately still names the SERVED locale — the page really is in
 * German — while `og:url` follows the canonical, so sharing the German URL
 * unfurls as the one page we want indexed.
 *
 * This is the exact behaviour `hreflang-return-metadata.test.ts` exists to
 * prevent everywhere else, and that remains right everywhere else: `/about`,
 * `/legal` and `/docs` are genuinely translated content, and cross-canonicalising
 * those is the W-22 "no return links" bug. Board content is the carve-out, not
 * the new default — which is why this is a separate function rather than a flag.
 * The board route files call into metadata 19 times between them (fallback,
 * notFound and redirect paths); a flag is one missed argument away from silently
 * self-canonicalising again, while a missing import is not.
 */
export function createBoardContentPageMetadata(options: PageMetadataOptions): Metadata {
  const metadata = createPageMetadata(options);
  const basePath = normalizePath(options.path);
  if (!basePath) {
    return metadata;
  }

  // Via `localeHref` rather than `basePath` directly: same value today, and it
  // stays correct if DEFAULT_LOCALE ever stops being the unprefixed one.
  const canonical = localeHref(basePath, DEFAULT_LOCALE);

  return {
    ...metadata,
    alternates: { canonical },
    openGraph: metadata.openGraph ? { ...metadata.openGraph, url: canonical } : metadata.openGraph,
  };
}

export function createNoIndexMetadata(options: Omit<PageMetadataOptions, 'robots'>): Metadata {
  return createPageMetadata({
    ...options,
    robots: { index: false, follow: true },
  });
}

export { absoluteUrl };
