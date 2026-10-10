import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SprayWallsContent from './spray-walls-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpSprayWalls.title'),
    description: t('metadata.helpSprayWalls.description'),
    path: '/help/spray-walls',
    locale,
  });
}

export default async function HelpSprayWallsPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <SprayWallsContent />
    </I18nProvider>
  );
}
