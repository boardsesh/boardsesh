import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import AboutContent from './about-content';
import { getPublicSupporters } from './server-public-supporters';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.about.title'),
    description: t('metadata.about.description'),
    path: '/about',
    locale,
  });
}

export default async function AboutPage() {
  const [locale, publicSupporters] = await Promise.all([getLocale(), getPublicSupporters()]);
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <AboutContent publicSupporters={publicSupporters} />
    </I18nProvider>
  );
}
