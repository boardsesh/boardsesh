import type { Metadata, Viewport } from 'next';
import { LOCALE_OG, type Locale } from '@/app/lib/i18n/config';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { SITE_URL } from './base-url';
import { themeTokens } from '@/app/theme/theme-config';

export const marketingDocumentViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-visual',
  themeColor: themeTokens.semantic.background,
};

/** Every input is public and explicit, so a parent metadata read cannot opt pages out of prerendering. */
export async function getMarketingDocumentMetadata(locale: Locale): Promise<Metadata> {
  const { t } = await getServerTranslationForLocale(locale, 'marketing');
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: t('metadata.home.title'), template: '%s | Boardsesh' },
    description: t('metadata.home.description'),
    openGraph: { type: 'website', siteName: 'Boardsesh', locale: LOCALE_OG[locale] },
    twitter: { card: 'summary_large_image' },
    icons: {
      icon: [{ url: '/icon.png', type: 'image/png', sizes: '512x512' }],
      apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
    },
  };
}
