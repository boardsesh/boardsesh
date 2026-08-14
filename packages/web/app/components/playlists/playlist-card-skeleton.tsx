'use client';

import React from 'react';
import Skeleton from '@mui/material/Skeleton';
import styles from './playlist-link-card.module.css';

type PlaylistCardSkeletonProps = {
  /** Number of skeleton cards to render. Matches the pre-W-13
   *  `PlaylistScrollSection`'s `ScrollSkeletons` default of 4. */
  count?: number;
};

/**
 * Placeholder cards rendered inside `.cardGrid` while a section's playlists
 * are still loading. Same compact shape as `PlaylistLinkCard` — a square plus
 * two text lines — so nothing shifts once the real cards mount.
 *
 * `/playlists` lost this mounted loading state when W-13 replaced the
 * horizontal-scroll `PlaylistScrollSection` (which had its own skeleton) with
 * the plain static grid; this restores the same reserved-space behaviour for
 * the grid layout.
 */
export default function PlaylistCardSkeleton({ count = 4 }: PlaylistCardSkeletonProps) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={styles.skeletonCompact} data-testid="playlist-card-skeleton">
          {/* 48x48 as props, not as a class: MUI's own Skeleton style sets
              `height: 1.2em`, and a CSS-module rule only beats it if the module
              stylesheet happens to land after emotion's — nothing guarantees
              that (the app mounts AppRouterCacheProvider without
              `enableCssLayer`). Props render as inline styles, so the square
              holds wherever the cascade falls. Same call shape as
              library/playlist-card-grid.tsx. */}
          <Skeleton variant="rounded" animation="wave" width={48} height={48} />
          <div className={styles.cardCompactInfo}>
            <Skeleton variant="text" animation="wave" width="70%" />
            <Skeleton variant="text" animation="wave" width="40%" />
          </div>
        </div>
      ))}
    </>
  );
}
