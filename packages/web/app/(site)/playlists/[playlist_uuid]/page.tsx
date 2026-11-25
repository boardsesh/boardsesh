import React from 'react';
import { buildClimbThumbnailCrops } from '@/app/lib/climb-thumbnail-crop.server';
import { getBoardImageDetailsForPlaylist } from '@/app/lib/board-image-details';
import type { Metadata } from 'next';
import type { Locale } from '@/app/lib/i18n/config';
import { notFound } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { serverMyBoards, serverPlaylist, serverPlaylistClimbs } from '@/app/lib/graphql/server-cached-client';
import { generatePlaylistMetadata } from '@/app/lib/seo/playlist-metadata';
import { getPlaylistOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { playlistQrUrl } from '@/app/lib/gym-attribution';
import { boardTypeProperty } from '@boardsesh/analytics';
import I18nProvider from '@/app/components/providers/i18n-provider';
import PhoneQrCard from '@/app/components/climb-front-door/phone-qr-card';
import QrLandingTracker from '@/app/components/climb-front-door/qr-landing-tracker';
import PlaylistDetailContent from '@/app/playlists/[playlist_uuid]/playlist-detail-content';

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
  //
  // The grade band rides on `getPlaylistOgSummary`, which `generateMetadata`
  // already called for this request: React `cache()` hands back the same
  // result, so the subline costs no query. It covers public playlists only, so
  // a private one shows no band.
  const [initialMyBoards, playlistResult, ogSummary] = await Promise.all([
    authToken ? serverMyBoards(authToken) : null,
    serverPlaylist(authToken, playlist_uuid),
    getPlaylistOgSummary(playlist_uuid).catch(() => null),
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

  // The laptop's QR code, only for a public playlist: a private one's link
  // opens nothing on a phone that is not signed in as its owner. Rendered here,
  // on the server, and handed to the client component as a finished node, so
  // the code ships as plain SVG and `qrcode.react` stays out of the client.
  const publicPlaylist = initialPlaylist?.isPublic ? initialPlaylist : null;
  const qrCard = publicPlaylist ? await buildPlaylistQrCard(playlist_uuid, publicPlaylist.name, locale) : null;

  return (
    <I18nProvider
      locale={locale}
      namespaces={['climbs', 'playlists', 'settings', 'marketing']}
      resourceKeys={{ marketing: ['home.hero'] }}
    >
      {/* A phone that scanned the laptop's QR code lands here: count it once. */}
      {publicPlaylist ? (
        <QrLandingTracker kind="playlist" boardType={boardTypeProperty(publicPlaylist.boardType).boardType} />
      ) : null}
      <PlaylistDetailContent
        qrCard={qrCard}
        playlistUuid={playlist_uuid}
        locale={locale}
        gradeSummary={ogSummary?.gradeSummary ?? null}
        initialMyBoards={initialMyBoards}
        initialPlaylist={initialPlaylist}
        initialClimbs={initialClimbs}
        thumbnailCropsByClimb={buildClimbThumbnailCrops(initialClimbs?.climbs ?? [], (climb) =>
          getBoardImageDetailsForPlaylist(climb.boardType ?? initialPlaylist?.boardType ?? '', climb.layoutId),
        )}
      />
    </I18nProvider>
  );
}

async function buildPlaylistQrCard(playlistUuid: string, playlistName: string, locale: Locale) {
  const [{ t }, { t: tClimbs }, storeButtonLabels] = await Promise.all([
    getServerTranslation('playlists'),
    getServerTranslation('climbs'),
    getStoreButtonLabels(),
  ]);
  return (
    <PhoneQrCard
      url={playlistQrUrl(playlistUuid, locale)}
      title={t('detail.qr.title')}
      body={tClimbs('frontDoor.qr.body')}
      imageLabel={t('detail.qr.imageLabel', { name: playlistName })}
      placement="playlist-qr-card"
      storeLabels={storeButtonLabels}
      qrLanding="playlist"
    />
  );
}
