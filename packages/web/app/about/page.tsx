import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import AboutContent from './about-content';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_PUBLIC_SUPPORTERS, type GetPublicSupportersResponse } from '@boardsesh/graphql/operations/support';

export const dynamic = 'force-dynamic';

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
  let stripeSupporters: GetPublicSupportersResponse['publicSupporters'] = [];
  try {
    const response = await createGraphQLHttpClient().request<GetPublicSupportersResponse>(GET_PUBLIC_SUPPORTERS);
    stripeSupporters = response.publicSupporters;
  } catch {
    // Static GitHub acknowledgements still render if the backend is unavailable.
  }
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <AboutContent stripeSupporters={stripeSupporters} />
    </I18nProvider>
  );
}
