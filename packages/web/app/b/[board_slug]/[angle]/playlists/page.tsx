import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolveBoardBySlug } from '@/app/lib/board-slug-utils';
import { constructBoardSlugPlaylistsUrl } from '@/app/lib/url-utils';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { serverMyBoards, serverUserPlaylists, cachedDiscoverPlaylists } from '@/app/lib/graphql/server-cached-client';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LibraryPageContent from '@/app/playlists/library-page-content';
import styles from '@/app/components/library/library.module.css';

type PlaylistsPageProps = {
  params: Promise<{ board_slug: string; angle: string }>;
};

export async function generateMetadata(props: PlaylistsPageProps): Promise<Metadata> {
  const params = await props.params;
  const { t, locale } = await getServerTranslation('playlists');
  return createPageMetadata({
    title: t('metadata.library.title'),
    description: t('metadata.library.description'),
    path: constructBoardSlugPlaylistsUrl(params.board_slug, Number(params.angle)),
    locale,
  });
}

export default async function BoardSlugPlaylistsPage(props: PlaylistsPageProps) {
  const params = await props.params;

  const board = await resolveBoardBySlug(params.board_slug);
  if (!board) {
    return notFound();
  }

  // SSR: fetch boards, playlists, and discover data in parallel
  const authToken = await getServerAuthToken();
  const locale = await getLocale();
  const playlistFilter = { boardType: board.boardType, layoutId: board.layoutId };

  const [initialMyBoards, initialPlaylists, initialDiscoverPlaylists] = await Promise.all([
    authToken ? serverMyBoards(authToken) : null,
    authToken ? serverUserPlaylists(authToken, playlistFilter) : null,
    cachedDiscoverPlaylists(playlistFilter),
  ]);

  return (
    <I18nProvider locale={locale} namespaces={['playlists']}>
      <div className={styles.pageContainer}>
        <LibraryPageContent
          boardSlug={params.board_slug}
          playlistsBasePath={constructBoardSlugPlaylistsUrl(params.board_slug, Number(params.angle))}
          initialMyBoards={initialMyBoards}
          initialPlaylists={initialPlaylists}
          initialDiscoverPlaylists={initialDiscoverPlaylists}
        />
      </div>
    </I18nProvider>
  );
}
