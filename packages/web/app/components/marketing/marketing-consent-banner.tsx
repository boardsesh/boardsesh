import { isChineseTranslationLocale } from '@boardsesh/i18n';
import { getConsentLabels } from '@/app/components/consent/consent-labels';
import ConsentPrompt from '@/app/components/consent/consent-prompt';
import { getChineseTranslationLabels } from '@/app/components/i18n/chinese-translation-labels';
import type { Locale } from '@/app/lib/i18n/config';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import ConsentWithChineseWelcome from './consent-with-chinese-welcome';

export default async function MarketingConsentBanner({ locale }: { locale: Locale }) {
  const includeChineseWelcome = isChineseTranslationLocale(locale);
  const namespaces = includeChineseWelcome ? (['consent', 'common'] as const) : 'consent';
  const { t, i18n } = await getServerTranslationForLocale(locale, namespaces);
  const labels = getConsentLabels(t);
  if (!includeChineseWelcome) return <ConsentPrompt labels={labels} />;
  const welcomeLabels = getChineseTranslationLabels(i18n.getFixedT(locale, 'common'));
  return <ConsentWithChineseWelcome labels={labels} welcomeLabels={welcomeLabels} />;
}
