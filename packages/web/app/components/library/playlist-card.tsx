'use client';

import React from 'react';
import IconButton from '@mui/material/IconButton';
import { PushPin, PushPinOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import PlaylistPreviewSquare from './playlist-preview-square';
import styles from './library.module.css';

export type PlaylistCardProps = {
  name: string;
  climbCount: number;
  boardType: string;
  layoutId?: number | null;
  /** Human board name (e.g. "Kilter", "Tension") shown on the scroll card so a
   *  cross-board playlist is legible before it's opened (#3825). */
  boardLabel?: string;
  color?: string;
  icon?: string;
  href: string;
  variant: 'grid' | 'scroll';
  index?: number;
  isLikedClimbs?: boolean;
  fetchPriority?: 'high' | 'low' | 'auto';
  /** When set, renders a pin toggle button on the grid variant. */
  isPinned?: boolean;
  /** Click handler for the pin button. Receives the new desired state. */
  onTogglePin?: (nextPinned: boolean) => void;
};

export default function PlaylistCard({
  name,
  climbCount,
  boardType,
  layoutId,
  boardLabel,
  color,
  icon,
  href,
  variant,
  index = 0,
  isLikedClimbs,
  fetchPriority,
  isPinned,
  onTogglePin,
}: PlaylistCardProps) {
  const { t } = useTranslation('playlists');
  const showPinButton = variant === 'grid' && onTogglePin != null;

  const handlePinClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onTogglePin?.(!isPinned);
  };

  if (variant === 'grid') {
    const card = (
      <LocaleLink href={href} className={styles.cardCompact}>
        <div className={styles.cardCompactSquare}>
          <PlaylistPreviewSquare
            boardType={boardType}
            layoutId={layoutId}
            color={color}
            icon={icon}
            isLikedClimbs={isLikedClimbs}
            index={index}
            className={styles.previewCompact}
            fetchPriority={fetchPriority}
          />
        </div>
        <div className={styles.cardCompactInfo}>
          <div className={styles.cardCompactName}>{name}</div>
          <div className={styles.cardMeta}>{t('detail.climbCount', { count: climbCount })}</div>
        </div>
      </LocaleLink>
    );

    if (!showPinButton) return card;

    return (
      <div className={styles.cardCompactWrapper}>
        {card}
        <IconButton
          size="small"
          className={styles.cardCompactPinButton}
          onClick={handlePinClick}
          aria-label={isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel')}
        >
          {isPinned ? <PushPin fontSize="small" /> : <PushPinOutlined fontSize="small" />}
        </IconButton>
      </div>
    );
  }

  return (
    <LocaleLink href={href} className={`${styles.card} ${styles.cardScroll}`}>
      <div className={styles.cardSquare}>
        <PlaylistPreviewSquare
          boardType={boardType}
          layoutId={layoutId}
          color={color}
          icon={icon}
          isLikedClimbs={isLikedClimbs}
          index={index}
          fetchPriority={fetchPriority}
        />
      </div>
      <div className={styles.cardName}>{name}</div>
      {boardLabel && <div className={styles.cardBoardLabel}>{boardLabel}</div>}
      <div className={styles.cardMeta}>
        {climbCount} {climbCount === 1 ? 'climb' : 'climbs'}
      </div>
    </LocaleLink>
  );
}
