import type { Metadata } from 'next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { Locale } from '@/app/lib/i18n/config';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata, createPageMetadata } from './metadata';
import { buildVersionedOgImagePath } from './og';
import { getPlaylistOgSummary } from './dynamic-og-data';

/**
 * Shortest owner-written description we will hand a search engine as the
 * snippet. Playlist descriptions are free text and the short ones are not
 * descriptions at all — a live page ships `"one day"` — which renders as a
 * snippet that says nothing about the playlist. Below this length the
 * generated line, which at least names the board and the climb count, wins.
 */
const MIN_OWNER_DESCRIPTION_CHARS = 30;

/**
 * Every branch goes through `createPageMetadata` / `createNoIndexMetadata` so a
 * playlist page emits exactly one canonical string plus the full hreflang set,
 * whichever route rendered it — the same "one canonical string per surface"
 * doctrine the climb list pages follow. `locale` is a required parameter rather
 * than a defaulted one so a call site cannot silently canonicalise /es onto
 * en-US.
 */
export async function generatePlaylistMetadata(playlistUuid: string, locale: Locale): Promise<Metadata> {
  const { t } = await getServerTranslation('playlists');
  const path = `/playlists/${encodeURIComponent(playlistUuid)}`;

  try {
    const playlist = await getPlaylistOgSummary(playlistUuid);

    // Kept even though the page body now calls `notFound()` on a missing
    // playlist, and the asymmetry is deliberate: the two branches read two
    // different queries. This one reads `getPlaylistOgSummary` (unauthenticated,
    // direct SQL); the body reads `serverPlaylist` (authenticated GraphQL). A
    // 404 from the body discards this metadata entirely, so a crawler still
    // sees one signal either way — and when the two disagree, the cost is a
    // noindexed 200 rather than a 404 on a playlist that exists. Not dead code.
    if (!playlist) {
      return createNoIndexMetadata({
        title: t('metadata.detail.fallbackTitle'),
        description: t('metadata.detail.fallbackDescription'),
        path,
        locale,
        imagePath: null,
      });
    }

    if (!playlist.isPublic) {
      return createNoIndexMetadata({
        title: t('metadata.detail.privateTitle'),
        description: t('metadata.detail.privateDescription'),
        path,
        locale,
        imagePath: null,
      });
    }

    const ownerDescription = playlist.description?.trim() ?? '';

    return createPageMetadata({
      title: playlist.name,
      description:
        ownerDescription.length >= MIN_OWNER_DESCRIPTION_CHARS
          ? ownerDescription
          : t('metadata.detail.generatedDescription', {
              count: playlist.climbCount,
              name: playlist.name,
              board: boardTypeLabel(playlist.boardType),
            }),
      path,
      locale,
      imagePath: buildVersionedOgImagePath('/api/og/playlist', { uuid: playlistUuid }, playlist.version),
      imageAlt: t('metadata.detail.ogAlt', { name: playlist.name }),
    });
  } catch {
    return createNoIndexMetadata({
      title: t('metadata.detail.fallbackTitle'),
      description: t('metadata.detail.fallbackDescription'),
      path,
      locale,
      imagePath: null,
    });
  }
}
