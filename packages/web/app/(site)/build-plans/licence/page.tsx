import React from 'react';
import type { Metadata } from 'next';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LicenceContent from '@/app/build-plans/licence/licence-content';

export async function generateMetadata(): Promise<Metadata> {
  // Existing licensees can read the final terms even when generation is disabled.
  const { t, locale } = await getServerTranslation('cnc-legal');
  // Keep the initial rollout noindex; indexing is a separate change.
  return createNoIndexMetadata({
    title: t('metadata.licence.title'),
    description: t('metadata.licence.description'),
    path: '/build-plans/licence',
    locale,
  });
}

export default async function BuildPlansLicencePage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['cnc-legal', 'common']}>
      <LicenceContent />
    </I18nProvider>
  );
}
