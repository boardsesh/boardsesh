import type { Locale } from '@/app/lib/i18n/config';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { createTrustFaqCopy } from './trust-faq-copy';
import TrustFaqContent from './trust-faq-content';

export default async function MarketingTrustFaq({ locale, limit = 8 }: { locale: Locale; limit?: 6 | 8 }) {
  const { t } = await getServerTranslationForLocale(locale, 'marketing');
  return <TrustFaqContent copy={createTrustFaqCopy(t, limit)} />;
}
