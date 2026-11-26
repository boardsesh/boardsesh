import type { Locale } from '@/app/lib/i18n/config';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { getSiteFooterLabels } from '../site-chrome/site-footer-labels';
import SiteFooterView from '../site-chrome/site-footer-view';

export default async function MarketingSiteFooter({
  locale,
  developerHref,
}: {
  locale: Locale;
  developerHref: '/developers' | '/docs';
}) {
  const { t } = await getServerTranslationForLocale(locale, ['common', 'consent']);
  const labels = getSiteFooterLabels(t, t('consent:privacyChoices'), locale);
  return <SiteFooterView labels={labels} developerHref={developerHref} />;
}
