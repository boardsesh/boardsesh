import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import ClimbActionsContent from './climb-actions-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpClimbActions.title'),
    description: t('metadata.helpClimbActions.description'),
    path: '/help/climb-actions',
    locale,
  });
}

export default async function HelpClimbActionsPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <ClimbActionsContent />
    </I18nProvider>
  );
}
