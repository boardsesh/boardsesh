'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Skeleton from '@mui/material/Skeleton';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import BoardseshBetaCard from './boardsesh-beta-card';
import styles from './boardsesh-beta.module.css';

type BoardseshBetaListSource = 'home' | 'drawer' | 'profile';

type BoardseshBetaListProps = {
  links: BetaLink[];
  isLoading: boolean;
  /**
   * When set, each card renders a top-anchored climb-name chip resolved
   * from this function. Used by the home-screen slider where the cards
   * come from many different climbs.
   */
  getClimbName?: (link: BetaLink) => string | null | undefined;
  /**
   * When set, the climb-name chip becomes a link to the climb's view
   * page. Falls back to a plain label when this returns null/undefined.
   */
  getClimbHref?: (link: BetaLink) => string | null | undefined;
  source?: BoardseshBetaListSource;
  /**
   * When true, the first card's thumbnail loads eagerly at high priority
   * because it's the above-the-fold LCP element. Only the home rail (which
   * renders directly under the hero) sets this; the drawer and profile lists
   * open behind an interaction and are never the page's LCP.
   */
  priorityFirstCard?: boolean;
};

const BoardseshBetaList: React.FC<BoardseshBetaListProps> = ({
  links,
  isLoading,
  getClimbName,
  getClimbHref,
  source = 'drawer',
  priorityFirstCard = false,
}) => {
  const { t } = useTranslation('common');
  // `data-source` is what the stylesheet reads to drop the inline inset on the
  // home rail, which already sits inside the page container's own padding.
  return (
    <div className={styles.section} data-source={source}>
      <div className={styles.scrollContainer}>
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={`skeleton-${i}`} className={styles.card}>
              <div className={styles.thumbnailWrapper}>
                <Skeleton variant="rectangular" sx={{ width: '100%', height: '100%' }} />
              </div>
            </div>
          ))
        ) : (
          <>
            {links.map((link, index) => (
              <BoardseshBetaCard
                key={link.link}
                link={link}
                climbName={getClimbName?.(link) ?? null}
                climbHref={getClimbHref?.(link) ?? null}
                source={source}
                priority={priorityFirstCard && index === 0}
              />
            ))}
            {links.length === 0 && <span className={styles.emptyText}>{t('betaVideos.empty')}</span>}
          </>
        )}
      </div>
    </div>
  );
};

export default BoardseshBetaList;
