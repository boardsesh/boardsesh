import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createNoIndexMetadata, NOINDEX_FOLLOW_ROBOTS } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { CNC_PACKS_FLAG } from '@/app/flags';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LicenceContent from '@/app/build-plans/licence/licence-content';

export async function generateMetadata(): Promise<Metadata> {
  // Public contract terms remain available independently of storefront rollout,
  // account identity and PostHog. Every other mode retains the beta access gate.
  if (process.env.CNC_RELEASE_MODE !== 'public') {
    const distinctId = await getPosthogDistinctId();
    const enabled = await getServerFeatureFlag(CNC_PACKS_FLAG, { distinctId, allowAnonymous: true });
    if (!enabled) return { robots: NOINDEX_FOLLOW_ROBOTS };
  }

  const { t, locale } = await getServerTranslation('cnc-legal');
  // Beta and the initial public rollout stay noindex. Publication copy is
  // selected independently; retiring the access flag and indexing are later work.
  return createNoIndexMetadata({
    title: t('metadata.licence.title'),
    description: t('metadata.licence.description'),
    path: '/build-plans/licence',
    locale,
  });
}

export default async function BuildPlansLicencePage() {
  const publicRelease = process.env.CNC_RELEASE_MODE === 'public';
  // Select public availability before any identity lookup: Terms must also be
  // readable while checkout is disabled or the storefront flag is rolled back.
  if (!publicRelease) {
    const distinctId = await getPosthogDistinctId();
    const enabled = await getServerFeatureFlag(CNC_PACKS_FLAG, { distinctId, allowAnonymous: true });
    if (!enabled) notFound();
  }

  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['cnc-legal', 'common']}>
      <LicenceContent publicRelease={publicRelease} />
    </I18nProvider>
  );
}
