import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import BetaVideosContent from './beta-videos-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpBetaVideos.title'),
    description: t('metadata.helpBetaVideos.description'),
    path: '/help/beta-videos',
    locale,
  });
}

export default async function HelpBetaVideosPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <BetaVideosContent />
    </I18nProvider>
  );
}
