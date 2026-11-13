import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import AuroraMigrationContent from './aurora-migration-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('aurora');
  return createPageMetadata({
    title: t('metadata.migration.title'),
    description: t('metadata.migration.description'),
    path: '/aurora-migration',
    locale,
  });
}

export default async function AuroraMigrationPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['common', 'aurora', 'settings', 'feed']}>
      <AuroraMigrationContent />
    </I18nProvider>
  );
}
