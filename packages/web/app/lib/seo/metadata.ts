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
  imageWidth?: number;
  imageHeight?: number;
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
              width: imageWidth,
              height: imageHeight,
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

export function createNoIndexMetadata(options: Omit<PageMetadataOptions, 'robots'>): Metadata {
  return createPageMetadata({
    ...options,
    robots: { index: false, follow: true },
  });
}

export { absoluteUrl };
