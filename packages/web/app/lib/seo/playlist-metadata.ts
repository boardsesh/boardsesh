import type { Metadata } from 'next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import type { Locale } from '@/app/lib/i18n/config';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata, createPageMetadata } from './metadata';
import { getPlaylistOgSummary, type PlaylistOgSummary } from './dynamic-og-data';
import { buildOgFamilyImageUrl } from './og-family';

/**
 * Shortest owner-written description we will hand a search engine as the
 * snippet. Playlist descriptions are free text and the short ones are not
 * descriptions at all — a live page ships `"one day"` — which renders as a
 * snippet that says nothing about the playlist. Below this length the
 * generated line, which at least names the board and the climb count, wins.
 */
const MIN_OWNER_DESCRIPTION_CHARS = 30;

type PlaylistTranslate = Awaited<ReturnType<typeof getServerTranslation>>['t'];

/**
 * The V-grade band the card prints as its hero (`V5–V9`), or null when the list
 * has too few graded climbs for one. Same percentiles, same scale.
 */
function resolveGradeBand(playlist: PlaylistOgSummary): { low: string; high: string } | null {
  const { gradeSummary } = playlist;
  if (!gradeSummary) return null;
  const grades = getBoulderGradesForBoard(playlist.boardType);
  const low = grades.find((grade) => grade.difficulty_id === gradeSummary.p10Difficulty);
  const high = grades.find((grade) => grade.difficulty_id === gradeSummary.p90Difficulty);
  return low && high ? { low: low.v_grade, high: high.v_grade } : null;
}

/** What a chat app shows above the card. The creator's name stays off both lines, as it does on the card. */
function buildPlaylistShareCopy(
  playlist: PlaylistOgSummary,
  ownerDescription: string,
  t: PlaylistTranslate,
): { ogTitle: string; ogDescription: string } {
  const board = boardTypeLabel(playlist.boardType);
  const band = resolveGradeBand(playlist);
  const count = playlist.climbCount;

  let ogTitle: string;
  let generated: string;
  if (!band) {
    ogTitle = t('metadata.detail.ogTitle', { name: playlist.name, board });
    generated = t('metadata.detail.ogDescriptionNoBand', { count, board });
  } else if (band.low === band.high) {
    ogTitle = t('metadata.detail.ogTitleWithBand', { name: playlist.name, band: band.low, board });
    generated = t('metadata.detail.ogDescriptionOneGrade', { count, board, grade: band.low });
  } else {
    ogTitle = t('metadata.detail.ogTitleWithBand', { name: playlist.name, band: `${band.low}–${band.high}`, board });
    generated = t('metadata.detail.ogDescriptionRange', { count, board, low: band.low, high: band.high });
  }
  return {
    ogTitle,
    ogDescription: ownerDescription.length >= MIN_OWNER_DESCRIPTION_CHARS ? ownerDescription : generated,
  };
}

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
    const { ogTitle, ogDescription } = buildPlaylistShareCopy(playlist, ownerDescription, t);
    // Only a public list reaches here, which is the backend card's own gate.
    // With no backend origin to point at, the site default card stands in.
    const imageUrl = buildOgFamilyImageUrl('playlist', { uuid: playlistUuid }, playlist.version);

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
      ogTitle,
      ogDescription,
      path,
      locale,
      ...(imageUrl ? { imagePath: imageUrl } : {}),
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
