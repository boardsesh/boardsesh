import React from 'react';
import type { Metadata } from 'next';
import SetterProfileContent from './setter-profile-content';
import styles from '@/app/components/ui/page-container.module.css';
import { buildVersionedOgImagePath } from '@/app/lib/seo/og';
import { createBoardContentPageMetadata, createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getSetterOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ setter_username: string }>;
}): Promise<Metadata> {
  const { setter_username } = await params;
  const username = decodeURIComponent(setter_username);
  // `locale` is load-bearing: without it every /es, /fr and /de setter page
  // canonicalises onto its en-US twin and de-indexes the localised tree.
  const { t, locale } = await getServerTranslation('profile');
  // Decoded once, encoded once, so the canonical is byte-stable no matter how
  // the crawler encoded the incoming path.
  const path = `/setter/${encodeURIComponent(username)}`;

  try {
    const summary = await getSetterOgSummary(username);
    const displayName = summary.displayName;

    return createBoardContentPageMetadata({
      title: t('metadata.setter.title', { name: displayName }),
      description: t('metadata.setter.description', { name: displayName }),
      path,
      locale,
      openGraphType: 'profile',
      imagePath: buildVersionedOgImagePath('/api/og/setter', { username }, summary.version),
      imageAlt: t('metadata.setter.ogAlt', { name: displayName }),
    });
  } catch {
    // The lookup failing is not evidence the setter exists, so keep the error
    // page out of the index — it previously emitted no canonical at all.
    return createNoIndexMetadata({
      title: t('metadata.setter.fallbackTitle'),
      description: t('metadata.setter.fallbackDescription'),
      path,
      locale,
      imagePath: null,
    });
  }
}

export default async function SetterProfilePage({ params }: { params: Promise<{ setter_username: string }> }) {
  const { setter_username } = await params;
  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['profile']}>
      <div className={styles.pageContainer}>
        <SetterProfileContent username={decodeURIComponent(setter_username)} />
      </div>
    </I18nProvider>
  );
}
