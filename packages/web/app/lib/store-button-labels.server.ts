import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { Locale } from './i18n/config';
import { getServerTranslation, getServerTranslationForLocale } from './i18n/server';

/**
 * The store button wording, translated on the server for a page that renders
 * `StoreInstallButtons` without shipping the `marketing` namespace to the
 * browser. The same three strings the home hero and /help use, so a store
 * button reads the same wherever it is.
 *
 * Server only through `getServerTranslation`, whose module carries the
 * `server-only` guard.
 */
export async function getStoreButtonLabels(requestedLocale?: Locale): Promise<StoreButtonLabels> {
  const { t, locale } = requestedLocale
    ? await getServerTranslationForLocale(requestedLocale, 'marketing')
    : await getServerTranslation('marketing');
  return {
    ios: t('home.hero.ctaInstallIos'),
    android: t('home.hero.ctaInstallAndroid'),
    update: t('home.hero.ctaUpdate'),
    locale,
  };
}
