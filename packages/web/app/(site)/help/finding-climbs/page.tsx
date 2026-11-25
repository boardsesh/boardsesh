import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import FindingClimbsContent from '@/app/help/finding-climbs/finding-climbs-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpFindingClimbs.title'),
    description: t('metadata.helpFindingClimbs.description'),
    path: '/help/finding-climbs',
    locale,
  });
}

export default async function HelpFindingClimbsPage() {
  const locale = await getLocale();
  return (
    <I18nProvider
      locale={locale}
      namespaces={['marketing']}
      resourceKeys={{ marketing: ['help.climbs', 'help.clip', 'help.nav', 'help.install', 'home.hero'] }}
    >
      <FindingClimbsContent />
    </I18nProvider>
  );
}
