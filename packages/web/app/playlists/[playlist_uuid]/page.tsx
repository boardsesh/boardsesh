import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { serverMyBoards, serverPlaylist, serverPlaylistClimbs } from '@/app/lib/graphql/server-cached-client';
import { generatePlaylistMetadata } from '@/app/lib/seo/playlist-metadata';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import PlaylistDetailContent from './playlist-detail-content';
import styles from '@/app/components/ui/page-container.module.css';

export async function generateMetadata({ params }: { params: Promise<{ playlist_uuid: string }> }): Promise<Metadata> {
  const { playlist_uuid } = await params;
  return generatePlaylistMetadata(playlist_uuid, await getLocale());
}

export default async function PlaylistDetailPage({ params }: { params: Promise<{ playlist_uuid: string }> }) {
  const { playlist_uuid } = await params;

  const authToken = await getServerAuthToken();
  const locale = await getLocale();
  // Fetch boards + playlist in parallel, then gate the climbs request on a
  // successful playlist lookup. Speculatively firing climbs alongside the
  // playlist would shave one round-trip on the hot path but double the
  // backend load on 404s — not worth it for a non-existent playlist.
  const [initialMyBoards, playlistResult] = await Promise.all([
    authToken ? serverMyBoards(authToken) : null,
    serverPlaylist(authToken, playlist_uuid),
  ]);

  // A UUID nobody owns used to render a 200 shell with no heading and no
  // content — the exact shape Search Console files as a soft 404. Answer the
  // status code that is true instead.
  //
  // Only `missing` 404s. `unavailable` means the GraphQL call failed, and the
  // client component refetches on mount, so the page still resolves for a real
  // playlist during a backend blip rather than being 404'd out of the index.
  if (playlistResult.status === 'missing') notFound();

  const initialPlaylist = playlistResult.status === 'found' ? playlistResult.playlist : null;

  const initialClimbs = initialPlaylist
    ? await serverPlaylistClimbs(authToken, { playlistId: playlist_uuid, page: 0, pageSize: 20 })
    : null;

  return (
    <I18nProvider
      locale={locale}
      namespaces={['common', 'climbs', 'session', 'boards', 'profile', 'feed', 'playlists']}
    >
      <div className={styles.pageContainer}>
        <PlaylistDetailContent
          playlistUuid={playlist_uuid}
          initialMyBoards={initialMyBoards}
          initialPlaylist={initialPlaylist}
          initialClimbs={initialClimbs}
        />
      </div>
    </I18nProvider>
  );
}
