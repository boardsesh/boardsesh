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
   * Board type (e.g. "kilter", "tension"). Passed to each card so the delete
   * action knows which board the link belongs to.
   */
  boardType?: string | null;
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
};

const BoardseshBetaList: React.FC<BoardseshBetaListProps> = ({
  links,
  isLoading,
  boardType,
  getClimbName,
  getClimbHref,
  source = 'drawer',
}) => {
  const { t } = useTranslation('common');
  return (
    <div className={styles.section}>
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
            {links.map((link) => (
              <BoardseshBetaCard
                key={link.link}
                link={link}
                boardType={boardType}
                climbName={getClimbName?.(link) ?? null}
                climbHref={getClimbHref?.(link) ?? null}
                source={source}
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
