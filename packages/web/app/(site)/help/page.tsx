import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import HelpContent from '@/app/help/help-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.help.title'),
    description: t('metadata.help.description'),
    path: '/help',
    locale,
  });
}

export default async function HelpPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <HelpContent developerDocsState={getDeveloperDocsState()} />
    </I18nProvider>
  );
}
