'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import PlaylistPreviewSquare from './playlist-preview-square';
import previewStyles from './playlist-preview-square.module.css';
import styles from './playlist-link-card.module.css';

/**
 * One crawlable playlist card: a real `<a href>` to the playlist, wrapping the
 * artwork square and the name/count block and nothing else.
 *
 * Deliberately has no `variant`, no pin toggle and no `onClick`. A button
 * nested inside an anchor is invalid HTML and unusable from the keyboard (the
 * same rule `climb-list/static-climb-row.tsx` documents), and pinning a
 * playlist is an app action now.
 */
export type PlaylistLinkCardProps = {
  name: string;
  climbCount: number;
  boardType: string;
  layoutId?: number | null;
  color?: string;
  icon?: string;
  href: string;
  index?: number;
  fetchPriority?: 'high' | 'low' | 'auto';
};

function PlaylistLinkCard({
  name,
  climbCount,
  boardType,
  layoutId,
  color,
  icon,
  href,
  index = 0,
  fetchPriority,
}: PlaylistLinkCardProps) {
  const { t } = useTranslation('playlists');

  return (
    // prefetch={false} is load-bearing: up to 20 cards render per section on a
    // page that already carries its own GraphQL fetch, and the App Router
    // default would fire a route prefetch for every one of them.
    <LocaleLink href={href} className={styles.cardCompact} prefetch={false}>
      <div className={styles.cardCompactSquare}>
        <PlaylistPreviewSquare
          boardType={boardType}
          layoutId={layoutId}
          color={color}
          icon={icon}
          index={index}
          className={previewStyles.previewCompact}
          fetchPriority={fetchPriority}
        />
      </div>
      <div className={styles.cardCompactInfo}>
        <div className={styles.cardCompactName}>{name}</div>
        <div className={styles.cardMeta}>{t('detail.climbCount', { count: climbCount })}</div>
      </div>
    </LocaleLink>
  );
}

export default React.memo(PlaylistLinkCard);
