import React from 'react';
import type { Metadata } from 'next';
import ClimbsContent from './climbs-content';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type PageProps = { params: Promise<{ user_id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerTranslation('profile');
  return {
    title: `${t('metadata.climbs.title')} | Boardsesh`,
    robots: { index: false, follow: true },
  };
}

export default async function ProfileClimbsPage({ params }: PageProps) {
  const { user_id } = await params;
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['profile', 'climbs']}>
      <ClimbsContent userId={user_id} />
    </I18nProvider>
  );
}
