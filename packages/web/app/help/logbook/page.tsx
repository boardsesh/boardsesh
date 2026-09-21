import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LogbookContent from './logbook-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpLogbook.title'),
    description: t('metadata.helpLogbook.description'),
    path: '/help/logbook',
    locale,
  });
}

export default async function HelpLogbookPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <LogbookContent />
    </I18nProvider>
  );
}
