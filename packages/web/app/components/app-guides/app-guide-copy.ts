import type { Metadata } from 'next';
import type { TFunction } from 'i18next';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { APP_GUIDE_LOCALES } from '@/app/lib/i18n/published-locales';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import type { AppGuidePage } from '@/app/lib/seo/app-guides';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { SMART_APP_BANNER_META_NAME, smartAppBannerContent } from '@/app/lib/smart-app-banner';

export type AppGuideCopy = { t: TFunction; storeLabels: StoreButtonLabels };

export async function loadAppGuideCopy(): Promise<AppGuideCopy> {
  const [{ t }, storeLabels] = await Promise.all([
    getServerTranslationForLocale(DEFAULT_LOCALE, 'appGuides'),
    getStoreButtonLabels(DEFAULT_LOCALE),
  ]);
  return { t, storeLabels };
}

export async function getAppGuideMetadata(guide: AppGuidePage): Promise<Metadata> {
  const { t } = await getServerTranslationForLocale(DEFAULT_LOCALE, 'appGuides');
  const title = t(`appGuides:pages.${guide.id}.meta.title`);
  const metadata = createPageMetadata({
    title,
    description: t(`appGuides:pages.${guide.id}.meta.description`),
    path: guide.path,
    locale: DEFAULT_LOCALE,
    availableLocales: APP_GUIDE_LOCALES,
    openGraphType: guide.id === 'spray-wall-apps' ? 'article' : 'website',
    // The page title itself: the default would be the branded search title, a
    // second " | Boardsesh" on a card that already names the site.
    imageAlt: title,
  });
  metadata.other = { [SMART_APP_BANNER_META_NAME]: smartAppBannerContent(guide.path, DEFAULT_LOCALE)! };
  // Comparison titles already name Boardsesh ("Boardsesh vs the Kilter Board App"),
  // and a long title (the hub's 58) has no room for " | Boardsesh" before the
  // 60-character cut: either way the suffix only pushes search words off the end.
  if (!/\bBoardsesh\b/.test(title) && `${title} | Boardsesh`.length <= 60) return metadata;
  return {
    ...metadata,
    title: { absolute: title },
    openGraph: { ...metadata.openGraph, title },
    twitter: { ...metadata.twitter, title },
  };
}
