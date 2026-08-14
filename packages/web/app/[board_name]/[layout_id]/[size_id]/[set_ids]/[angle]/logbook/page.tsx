import React from 'react';
import { notFound } from 'next/navigation';
import type { BoardRouteParameters } from '@/app/lib/types';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import type { Metadata } from 'next';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { serverMyBoards, serverUserPlaylists, cachedDiscoverPlaylists } from '@/app/lib/graphql/server-cached-client';
import LibraryPageContent from '@/app/playlists/library-page-content';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import styles from '@/app/components/library/library.module.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('climbs');
  return createNoIndexMetadata({
    title: t('metadata.logbook.title'),
    description: t('metadata.logbook.description'),
    locale,
  });
}

export default async function BoardLogbookPage(props: { params: Promise<BoardRouteParameters> }) {
  const params = await props.params;

  try {
    const parsed = await parseBoardRouteParamsWithSlugs(params);
    const playlistsBasePath = `/${params.board_name}/${params.layout_id}/${params.size_id}/${params.set_ids}/${params.angle}/playlists`;

    const authToken = await getServerAuthToken();
    const playlistFilter = { boardType: parsed.board_name, layoutId: parsed.layout_id };

    const [initialMyBoards, initialPlaylists, initialDiscoverPlaylists] = await Promise.all([
      authToken ? serverMyBoards(authToken) : null,
      authToken ? serverUserPlaylists(authToken, playlistFilter) : null,
      cachedDiscoverPlaylists(playlistFilter),
    ]);

    return (
      <div className={styles.pageContainer}>
        <LibraryPageContent
          playlistsBasePath={playlistsBasePath}
          initialMyBoards={initialMyBoards}
          initialPlaylists={initialPlaylists}
          initialDiscoverPlaylists={initialDiscoverPlaylists}
        />
      </div>
    );
  } catch (error) {
    console.error('Error loading logbook page:', error);
    notFound();
  }
}
