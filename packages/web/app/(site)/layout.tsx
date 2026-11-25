import type React from 'react';
import { headers } from 'next/headers';
import type { Viewport, Metadata } from 'next';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { LOCALE_OG } from '@/app/lib/i18n/config';
import { PATHNAME_HEADER } from '@/app/lib/request-pathname-header';
import { SITE_URL } from '@/app/lib/seo/base-url';
import { SMART_APP_BANNER_META_NAME, smartAppBannerContent } from '@/app/lib/smart-app-banner';
import { themeTokens } from '@/app/theme/theme-config';

export async function generateMetadata(): Promise<Metadata> {
  const [{ t, locale }, requestHeaders] = await Promise.all([getServerTranslation('marketing'), headers()]);
  // The page the visitor is on, as middleware saw it: locale prefix stripped,
  // query string left off. `null` on a request no middleware saw.
  const bannerContent = smartAppBannerContent(requestHeaders.get(PATHNAME_HEADER), locale);
  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: t('metadata.home.title'),
      template: '%s | Boardsesh',
    },
    description: t('metadata.home.description'),
    openGraph: {
      type: 'website',
      siteName: 'Boardsesh',
      locale: LOCALE_OG[locale],
    },
    twitter: {
      card: 'summary_large_image',
    },
    // The iOS Smart App Banner (#6027). Next's own `itunes` field cannot carry
    // the campaign token, so the tag is written through `other`. No page sets
    // `other` today; one that starts to replaces this object and loses the
    // banner, so it has to spread the tag back in.
    ...(bannerContent ? { other: { [SMART_APP_BANNER_META_NAME]: bannerContent } } : {}),
    // Same-origin, and no CDN copy of anything Next already serves itself.
    //
    // Next always emits `app/favicon.ico` on its own (the favicon slot is
    // unshifted unconditionally, unlike the rest of the file convention, which
    // this block suppresses). Pointing the other entries at assets.boardsesh.com
    // therefore left four competing `rel="icon"` declarations, three of them on
    // a DNS-only Tigris host with no robots.txt, no edge cache and a 614 ms
    // TTFB. A crawler picks one favicon per site; the cheapest thing we can do
    // is stop giving it a choice between four, on two hosts, for a 28 KB file.
    //
    // `sizes` are the real ones: favicon.ico's largest entry is 48×48 (Next
    // reads that itself), icon.png is 512², apple-touch is 180².
    icons: {
      icon: [{ url: '/icon.png', type: 'image/png', sizes: '512x512' }],
      apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Match Mobile Safari behavior on Android: keyboard overlays the page
  // without resizing the layout viewport, so 100dvh and position:fixed
  // bottom bars stay anchored when an input is focused.
  interactiveWidget: 'resizes-visual',
  // The page base, not the shared Material anchor — velvet-tokens-parity
  // asserts web's ground is deliberately NOT materialSurfaces.dark.background.
  themeColor: themeTokens.semantic.background,
};

export default async function ApplicationRootLayout({ children }: { children: React.ReactNode }) {
  const [locale, requestHeaders] = await Promise.all([getLocale(), headers()]);
  const { default: ApplicationDocument } = await import('@/app/components/providers/application-document');
  return (
    <ApplicationDocument locale={locale} requestHeaders={requestHeaders}>
      {children}
    </ApplicationDocument>
  );
}
