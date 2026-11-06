import React from 'react';
import type { Metadata } from 'next';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { fetchProfileStatsData } from '../server-profile-stats';
import AnalyticsContent from './analytics-content';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type PageProps = { params: Promise<{ user_id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerTranslation('profile');
  return {
    title: `${t('metadata.statistics.title')} | Boardsesh`,
    robots: { index: false, follow: true },
  };
}

export default async function ProfileStatisticsPage({ params }: PageProps) {
  const { user_id } = await params;
  const session = await getAdmittedServerSession();
  const viewerUserId = session?.user?.id;

  const statsData = await fetchProfileStatsData(user_id);
  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['profile']}>
      <AnalyticsContent
        userId={user_id}
        initialProfileStats={statsData.initialProfileStats}
        initialPercentile={statsData.initialPercentile}
        initialAllBoardsTicks={statsData.initialAllBoardsTicks}
        initialLogbook={statsData.initialLogbook}
        initialIsOwnProfile={viewerUserId === user_id}
      />
    </I18nProvider>
  );
}
