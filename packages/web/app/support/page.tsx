import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import SupportContent from './support-content';
import { resolveStripeDonateUrl } from './stripe-donate-url';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.support.title'),
    description: t('metadata.support.description'),
    path: '/support',
    locale,
  });
}

export default async function SupportPage() {
  const locale = await getLocale();
  const stripeDonateUrl = resolveStripeDonateUrl();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <SupportContent stripeDonateUrl={stripeDonateUrl} />
    </I18nProvider>
  );
}
