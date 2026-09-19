import React from 'react';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import PlaylistsContent from './playlists-content';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('marketing');
  return createPageMetadata({
    title: t('metadata.helpPlaylists.title'),
    description: t('metadata.helpPlaylists.description'),
    path: '/help/playlists',
    locale,
  });
}

export default async function HelpPlaylistsPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} namespaces={['marketing']}>
      <PlaylistsContent />
    </I18nProvider>
  );
}
