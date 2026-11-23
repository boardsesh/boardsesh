'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import BoardseshBetaCard, { type BoardseshBetaCardSource } from './boardsesh-beta-card';
import BoardseshBetaGridCard from './boardsesh-beta-grid-card';
import styles from './boardsesh-beta.module.css';

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
  source?: BoardseshBetaCardSource;
  /**
   * When true, the first card's thumbnail loads eagerly at high priority
   * because it's the above-the-fold LCP element. Only the home rail (which
   * renders directly under the hero) sets this; the drawer and profile lists
   * open behind an interaction and are never the page's LCP.
   */
  priorityFirstCard?: boolean;
  /**
   * `rail` (the default) is the horizontal strip of 9:16 thumbnails. `grid` is
   * the climb page's list: two cards a row from md, and below md a snap
   * scroller where the next card peeks in. Grid cards keep a video with no
   * thumbnail as a play tile.
   */
  layout?: 'rail' | 'grid';
};

/** Cards the md+ grid shows before "Show all": three rows. */
const GRID_PREVIEW_COUNT = 6;

// Below md every card is already in the sideways scroller, so the button hides.
const showAllSx = { display: { xs: 'none', md: 'inline-flex' }, mt: 1, minHeight: 44 };

type BoardseshBetaGridProps = {
  links: BetaLink[];
  isLoading: boolean;
  source: BoardseshBetaCardSource;
};

/**
 * The grid layout. From md it shows the first three rows and a "Show all N
 * videos" button, because a popular climb can carry over a hundred videos and
 * an uncapped 2-up grid would run for metres. The rest are still rendered,
 * only `display: none` on md+, so every video link stays in the server HTML,
 * and their lazy thumbnails do not load until shown. Below md every card sits
 * in the sideways scroller, where length costs nothing, and the button hides.
 */
function BoardseshBetaGrid({ links, isLoading, source }: BoardseshBetaGridProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const firstRevealedLinkRef = useRef<HTMLAnchorElement>(null);

  // "Show all" removes itself, which would drop keyboard focus to <body>. Hand
  // it to the first card it revealed, where the reader's next Tab would go.
  useEffect(() => {
    if (expanded) firstRevealedLinkRef.current?.focus();
  }, [expanded]);

  if (isLoading) {
    return (
      <Box className={styles.section} data-layout="grid">
        <Box component="ul" className={styles.grid}>
          {Array.from({ length: 2 }).map((_, index) => (
            <Box component="li" key={`skeleton-${index}`} className={styles.gridItem}>
              <Skeleton variant="rounded" className={styles.gridSkeleton} />
            </Box>
          ))}
        </Box>
      </Box>
    );
  }
  if (links.length === 0) {
    return (
      <Box className={styles.section} data-layout="grid">
        <Box component="span" className={styles.emptyText}>
          {t('betaVideos.empty')}
        </Box>
      </Box>
    );
  }
  return (
    <Box className={styles.section} data-layout="grid">
      <Box component="ul" className={styles.grid} data-expanded={expanded ? 'true' : undefined}>
        {links.map((link, index) => (
          <BoardseshBetaGridCard
            key={link.link}
            link={link}
            source={source}
            beyondPreview={index >= GRID_PREVIEW_COUNT}
            linkRef={index === GRID_PREVIEW_COUNT ? firstRevealedLinkRef : undefined}
          />
        ))}
      </Box>
      {links.length > GRID_PREVIEW_COUNT && !expanded ? (
        <Button variant="text" sx={showAllSx} onClick={() => setExpanded(true)}>
          {t('betaVideos.showAll', { total: links.length })}
        </Button>
      ) : null}
    </Box>
  );
}

const BoardseshBetaList: React.FC<BoardseshBetaListProps> = ({
  links,
  isLoading,
  getClimbName,
  getClimbHref,
  source = 'drawer',
  priorityFirstCard = false,
  layout = 'rail',
}) => {
  const { t } = useTranslation('common');
  const visibleLinks = source === 'home' ? links.filter((link) => Boolean(link.thumbnail)) : links;
  if (layout === 'grid') return <BoardseshBetaGrid links={visibleLinks} isLoading={isLoading} source={source} />;
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
            {visibleLinks.map((link, index) => (
              <BoardseshBetaCard
                key={link.link}
                link={link}
                climbName={getClimbName?.(link) ?? null}
                climbHref={getClimbHref?.(link) ?? null}
                source={source}
                priority={priorityFirstCard && index === 0}
              />
            ))}
            {visibleLinks.length === 0 && <span className={styles.emptyText}>{t('betaVideos.empty')}</span>}
          </>
        )}
      </div>
    </div>
  );
};

export default BoardseshBetaList;
