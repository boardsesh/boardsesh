import React from 'react';
import { notFound } from 'next/navigation';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { CNC_PACKS_FLAG } from '@/app/flags';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LicenceContent from './licence-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('cnc-legal');
  // `noindex, follow` for as long as the flag gates the page: a licence that is
  // still a draft must not be the thing Google shows for "boardsesh licence".
  // Launch removes this line and nothing else.
  return createNoIndexMetadata({
    title: t('metadata.licence.title'),
    description: t('metadata.licence.description'),
    path: '/build-plans/licence',
    locale,
  });
}

export default async function BuildPlansLicencePage() {
  // Same gate as every other `/build-plans` route. `allowAnonymous` because the
  // licence has to be readable before you buy — and therefore before you sign
  // in — the moment the flag goes to 100%.
  const distinctId = await getPosthogDistinctId();
  const enabled = await getServerFeatureFlag(CNC_PACKS_FLAG, { distinctId, allowAnonymous: true });
  if (!enabled) {
    notFound();
  }

  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['cnc-legal', 'common']}>
      <LicenceContent />
    </I18nProvider>
  );
}
