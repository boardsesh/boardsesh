import React from 'react';
import type { Metadata } from 'next';
import SetterProfileContent from './setter-profile-content';
import styles from '@/app/components/ui/page-container.module.css';
import { buildVersionedOgImagePath, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';
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
  const { t } = await getServerTranslation('profile');

  try {
    const summary = await getSetterOgSummary(username);
    const displayName = summary.displayName;
    const ogImagePath = buildVersionedOgImagePath('/api/og/setter', { username }, summary.version);
    const title = `${t('metadata.setter.title', { name: displayName })} | Boardsesh`;
    const description = t('metadata.setter.description', { name: displayName });
    const canonicalUrl = `/setter/${encodeURIComponent(setter_username)}`;

    return {
      title,
      description,
      alternates: { canonical: canonicalUrl },
      openGraph: {
        title,
        description,
        url: canonicalUrl,
        images: [
          {
            url: ogImagePath,
            width: OG_IMAGE_WIDTH,
            height: OG_IMAGE_HEIGHT,
            alt: t('metadata.setter.ogAlt', { name: displayName }),
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [ogImagePath],
      },
    };
  } catch {
    return {
      title: `${t('metadata.setter.fallbackTitle')} | Boardsesh`,
      description: t('metadata.setter.fallbackDescription'),
    };
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
