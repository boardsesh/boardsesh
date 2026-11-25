import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import AboutContent from '@/app/about/about-content';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';

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
  const locale = await getLocale();
  return (
    <I18nProvider
      locale={locale}
      namespaces={['marketing']}
      resourceKeys={{ marketing: ['about', 'funding', 'trust', 'preview'] }}
    >
      <AboutContent developerDocsState={getDeveloperDocsState()} />
    </I18nProvider>
  );
}
