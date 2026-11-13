import React from 'react';
import type { Metadata } from 'next';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import ProfileSessionsContent from './sessions-content';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

type PageProps = { params: Promise<{ user_id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerTranslation('profile');
  return {
    title: `${t('metadata.sessions.title')} | Boardsesh`,
    robots: { index: false, follow: true },
  };
}

export default async function ProfileSessionsPage({ params }: PageProps) {
  const { user_id } = await params;
  const authToken = await getServerAuthToken();
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['profile', 'feed', 'session']}>
      <ProfileSessionsContent userId={user_id} isAuthenticatedSSR={!!authToken} />
    </I18nProvider>
  );
}
