import React from 'react';
import { notFound } from 'next/navigation';
import type { BoardRouteParameters } from '@/app/lib/types';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import type { Metadata } from 'next';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { serverMyBoards, serverUserPlaylists, cachedDiscoverPlaylists } from '@/app/lib/graphql/server-cached-client';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LibraryPageContent from '@/app/playlists/library-page-content';
import { getPlaylistLcpPreloadUrl } from '@/app/lib/lcp-preload-url';
import styles from '@/app/components/library/library.module.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('playlists');
  return createNoIndexMetadata({
    title: t('metadata.library.title'),
    description: t('metadata.library.description'),
    locale,
  });
}

export default async function PlaylistsPage(props: { params: Promise<BoardRouteParameters> }) {
  const params = await props.params;

  try {
    // Validate route params (throws if invalid board/layout/size/set combination)
    const parsed = await parseBoardRouteParamsWithSlugs(params);
    const playlistsBasePath = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/playlists`;

    // SSR: fetch boards, playlists, and discover data in parallel
    const authToken = await getServerAuthToken();
    const locale = await getLocale();
    const playlistFilter = { boardType: parsed.board_name, layoutId: parsed.layout_id };

    const [initialMyBoards, initialPlaylists, initialDiscoverPlaylists] = await Promise.all([
      authToken ? serverMyBoards(authToken) : null,
      authToken ? serverUserPlaylists(authToken, playlistFilter) : null,
      cachedDiscoverPlaylists(playlistFilter),
    ]);

    const lcpPreloadUrl = getPlaylistLcpPreloadUrl(
      initialPlaylists?.playlists?.[0] ?? initialDiscoverPlaylists?.popular?.[0],
    );

    return (
      <I18nProvider locale={locale} namespaces={['playlists']}>
        {lcpPreloadUrl && <link rel="preload" as="image" href={lcpPreloadUrl} fetchPriority="high" />}
        <div className={styles.pageContainer}>
          <LibraryPageContent
            playlistsBasePath={playlistsBasePath}
            initialMyBoards={initialMyBoards}
            initialPlaylists={initialPlaylists}
            initialDiscoverPlaylists={initialDiscoverPlaylists}
          />
        </div>
      </I18nProvider>
    );
  } catch (error) {
    console.error('Error loading playlists page:', error);
    notFound();
  }
}
