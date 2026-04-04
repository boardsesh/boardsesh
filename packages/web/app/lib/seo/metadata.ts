import type { Metadata } from 'next';

export const SITE_NAME = 'Boardsesh';
export const DEFAULT_OG_IMAGE_PATH = '/opengraph-image';

type PageMetadataOptions = {
  title: string;
  description: string;
  path?: string;
  imagePath?: string | null;
  imageAlt?: string;
  robots?: Metadata['robots'];
  keywords?: string[];
  openGraphType?: 'website' | 'article' | 'profile';
  twitterCard?: 'summary' | 'summary_large_image' | 'app' | 'player';
};

function normalizePath(path?: string): string | undefined {
  if (!path) {
    return undefined;
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

export function createPageMetadata({
  title,
  description,
  path,
  imagePath = DEFAULT_OG_IMAGE_PATH,
  imageAlt,
  robots,
  keywords,
  openGraphType = 'website',
  twitterCard = 'summary_large_image',
}: PageMetadataOptions): Metadata {
  const canonicalPath = normalizePath(path);
  const fullTitle = withBrandTitle(title);
  const normalizedImagePath = imagePath ? normalizePath(imagePath) : undefined;

  return {
    title: fullTitle,
    description,
    alternates: canonicalPath ? { canonical: canonicalPath } : undefined,
    robots,
    keywords,
    openGraph: {
      title: fullTitle,
      description,
      type: openGraphType,
      url: canonicalPath,
      siteName: SITE_NAME,
      images: normalizedImagePath
        ? [
            {
              url: normalizedImagePath,
              alt: imageAlt ?? fullTitle,
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
