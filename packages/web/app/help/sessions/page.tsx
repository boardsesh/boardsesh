import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SessionsContent from './sessions-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpSessions.title'),
    description: t('metadata.helpSessions.description'),
    path: '/help/sessions',
    locale,
  });
}

export default async function HelpSessionsPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <SessionsContent />
    </I18nProvider>
  );
}
