import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import { CNC_PACKS_FLAG } from '@/app/flags';
import LegalContent from './legal-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.legal.title'),
    description: t('metadata.legal.description'),
    path: '/legal',
    locale,
  });
}

export default async function LegalPage() {
  const locale = await getLocale();
  // `distinctId: null` with `allowAnonymous` on purpose: /legal is public and
  // indexable, so it must not read the session (that would make every render
  // dynamic) and the build-plans mention is the same for everyone.
  const showBuildPlans = await getServerFeatureFlag(CNC_PACKS_FLAG, { distinctId: null, allowAnonymous: true });
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <LegalContent showBuildPlans={showBuildPlans} />
    </I18nProvider>
  );
}
