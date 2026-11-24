import 'server-only';

import { APP_URL } from '@/app/lib/app-origin';
import { ORGANIZATION_ID, SAME_AS, WEBSITE_ID } from '@/app/components/seo/site-json-ld';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { SITE_NAME } from '@/app/lib/seo/metadata';
import type { AppGuidePage } from '@/app/lib/seo/app-guides';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } from '@/app/lib/store-urls';

type Crumb = { label: string; path: string };

const APP_ID = absoluteUrl('/#app');

/**
 * The day the guides first went live. `dateModified` follows each page's last
 * copy check; this one never moves.
 */
const APP_GUIDES_PUBLISHED_AT = '2026-11-24';

/**
 * Structured data for a comparison page: WebPage (dated, published by Boardsesh),
 * BreadcrumbList, the Organization, and a MobileApplication for Boardsesh only.
 * The hub adds an ItemList of the guides.
 *
 * Never Review or AggregateRating: the rating on the page is ours, and Google
 * treats self-controlled reviews as ineligible. Competitor apps get no markup.
 * No FAQPage either: FAQ rich results are gone, and the answers are page content.
 */
export function buildAppGuideJsonLd({
  guide,
  name,
  description,
  crumbs,
  items = [],
}: {
  guide: AppGuidePage;
  name: string;
  description: string;
  crumbs: readonly Crumb[];
  items?: readonly { name: string; path: string }[];
}): Record<string, unknown> {
  const canonical = absoluteUrl(guide.path);
  const breadcrumbId = `${canonical}#breadcrumb`;
  const logo = resolveShellStaticAssetUrl('/brand/boardsesh-mark.webp');
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': canonical,
        url: canonical,
        name,
        description,
        inLanguage: DEFAULT_LOCALE,
        datePublished: APP_GUIDES_PUBLISHED_AT,
        dateModified: guide.updatedAt,
        isPartOf: { '@id': WEBSITE_ID },
        breadcrumb: { '@id': breadcrumbId },
        publisher: { '@id': ORGANIZATION_ID },
        about: { '@id': APP_ID },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': breadcrumbId,
        itemListElement: crumbs.map((crumb, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: crumb.label,
          item: absoluteUrl(crumb.path),
        })),
      },
      {
        '@type': 'Organization',
        '@id': ORGANIZATION_ID,
        name: SITE_NAME,
        url: absoluteUrl(),
        logo: logo.startsWith('http') ? logo : absoluteUrl(logo),
        sameAs: SAME_AS,
      },
      { '@type': 'WebSite', '@id': WEBSITE_ID, name: SITE_NAME, url: absoluteUrl('/') },
      {
        '@type': 'MobileApplication',
        '@id': APP_ID,
        name: SITE_NAME,
        operatingSystem: 'iOS, Android',
        applicationCategory: 'SportsApplication',
        url: APP_URL,
        downloadUrl: [IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL],
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@id': ORGANIZATION_ID },
      },
      ...(items.length > 0
        ? [
            {
              '@type': 'ItemList',
              '@id': `${canonical}#guides`,
              itemListElement: items.map((item, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: item.name,
                url: absoluteUrl(item.path),
              })),
            },
          ]
        : []),
    ],
  };
}
