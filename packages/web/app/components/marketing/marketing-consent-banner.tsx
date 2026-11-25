'use client';

import ConsentBanner from '@/app/components/consent/consent-banner';
import ChineseTranslationOnboarding from '@/app/components/i18n/chinese-translation-onboarding';

export default function MarketingConsentBanner() {
  return <ConsentBanner>{(region) => <ChineseTranslationOnboarding consentRegion={region} />}</ConsentBanner>;
}
