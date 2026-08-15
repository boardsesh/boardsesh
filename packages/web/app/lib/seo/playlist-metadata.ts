import type { Metadata } from 'next';
import type { Locale } from '@/app/lib/i18n/config';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata, createPageMetadata } from './metadata';
import { buildVersionedOgImagePath } from './og';
import { getPlaylistOgSummary } from './dynamic-og-data';

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

    return createPageMetadata({
      title: playlist.name,
      description: playlist.description || t('metadata.detail.climbCountDescription', { count: playlist.climbCount }),
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
