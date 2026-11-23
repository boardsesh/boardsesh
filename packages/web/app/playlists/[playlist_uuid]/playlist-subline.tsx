import React from 'react';
import { useTranslation } from 'react-i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { resolvePlaylistGradeBand, type PlaylistGradeBandSummary } from '@/app/lib/playlist-grade-band';
import styles from '@/app/components/ui/page-container.module.css';

const SPRAY_BOARD_TYPE = 'spray';

/**
 * The boards a playlist spans: its own board first, then each other board its
 * climbs are on, in the order they first appear.
 */
export function playlistBoardTypes(
  playlistBoardType: string,
  climbs: ReadonlyArray<{ boardType?: string | null }>,
): string[] {
  const boardTypes = new Set<string>([playlistBoardType]);
  for (const climb of climbs) {
    if (climb.boardType) boardTypes.add(climb.boardType);
  }
  return [...boardTypes];
}

type PlaylistSublineProps = {
  /** From `playlistBoardTypes`; the first is the playlist's own board, whose grade scale the band is on. */
  boardTypes: readonly string[];
  climbCount: number;
  gradeSummary: PlaylistGradeBandSummary | null | undefined;
  locale: string;
};

/**
 * "Kilter playlist · 12 climbs · V0 to V8", under the h1.
 *
 * The band is the summary's 10th to 90th percentile, the one the share card
 * prints, and is left out when the playlist has no summary.
 */
export default function PlaylistSubline({ boardTypes, climbCount, gradeSummary, locale }: PlaylistSublineProps) {
  const { t } = useTranslation('playlists');
  const [playlistBoardType] = boardTypes;
  let kind: string;
  if (boardTypes.length > 1) {
    // A spray wall is not a brand, so its name is translated, unlike the board names.
    const boardLabels = boardTypes.map((boardType) =>
      boardType === SPRAY_BOARD_TYPE ? t('detail.subline.sprayWall') : boardTypeLabel(boardType),
    );
    kind = t('detail.subline.multiBoardPlaylist', {
      boards: new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(boardLabels),
    });
  } else if (playlistBoardType === SPRAY_BOARD_TYPE) {
    kind = t('detail.subline.sprayWallPlaylist');
  } else {
    kind = t('detail.subline.boardPlaylist', { board: boardTypeLabel(playlistBoardType) });
  }
  const band = resolvePlaylistGradeBand(playlistBoardType, gradeSummary);
  let bandText: string | null = null;
  if (band) {
    bandText = band.low === band.high ? band.low : t('detail.subline.gradeBand', { low: band.low, high: band.high });
  }

  // A plain <p>, not Typography: a MUI variant class ties a CSS-module class on
  // specificity and wins on injection order, which reset this line's size and gap.
  // The spaces between parts are for text and screen readers; the flex row
  // drops whitespace, and the dots are drawn in CSS.
  return (
    <p className={styles.heroSubline}>
      <span className={styles.heroSublineParts}>
        <span className={styles.heroKind}>{kind}</span>{' '}
        <span className={styles.heroFact}>{t('detail.climbCount', { count: climbCount })}</span>
        {bandText ? (
          <>
            {' '}
            <span className={styles.heroFact}>{bandText}</span>
          </>
        ) : null}
      </span>
    </p>
  );
}
