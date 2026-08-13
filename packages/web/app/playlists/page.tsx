import React from 'react';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { serverMyBoards, serverUserPlaylists, cachedDiscoverPlaylists } from '@/app/lib/graphql/server-cached-client';
import LibraryPageContent from './library-page-content';
import { getPlaylistLcpPreloadUrl } from '@/app/lib/lcp-preload-url';
import { getAllBoardConfigs } from '@/app/lib/server-board-configs';
import styles from '@/app/components/ui/page-container.module.css';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('playlists');
  return createPageMetadata({
    title: t('metadata.library.title'),
    description: t('metadata.library.description'),
    path: '/playlists',
    locale,
  });
}

export default async function PlaylistsPage() {
  // SSR: fetch boards, playlists (unfiltered), and discover data in parallel
  const authToken = await getServerAuthToken();
  const locale = await getLocale();

  const [initialMyBoards, initialPlaylists, initialDiscoverPlaylists, boardConfigs] = await Promise.all([
    authToken ? serverMyBoards(authToken) : null,
    authToken ? serverUserPlaylists(authToken) : null,
    cachedDiscoverPlaylists(),
    getAllBoardConfigs(),
  ]);

  const lcpPreloadUrl = getPlaylistLcpPreloadUrl(
    initialPlaylists?.playlists?.[0] ?? initialDiscoverPlaylists?.popular?.[0],
  );

  return (
    <I18nProvider locale={locale} namespaces={['playlists', 'climbs', 'feed']}>
      {lcpPreloadUrl && <link rel="preload" as="image" href={lcpPreloadUrl} fetchPriority="high" />}
      <div className={styles.libraryPageContainer}>
        <LibraryPageContent
          initialMyBoards={initialMyBoards}
          initialPlaylists={initialPlaylists}
          initialDiscoverPlaylists={initialDiscoverPlaylists}
          boardConfigs={boardConfigs}
        />
      </div>
    </I18nProvider>
  );
}
