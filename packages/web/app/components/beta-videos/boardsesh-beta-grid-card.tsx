'use client';

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import { track } from '@/app/lib/analytics';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { betaLinkPlatform } from './beta-link-platform';
import type { BoardseshBetaCardSource } from './boardsesh-beta-card';
import styles from './boardsesh-beta.module.css';

type BoardseshBetaGridCardProps = {
  link: BetaLink;
  /** Tagged on the click event so CTR can be measured per placement. */
  source: BoardseshBetaCardSource;
  /** Past the grid's first rows: hidden on md+ until the reader asks for all of them. */
  beyondPreview?: boolean;
  /** The card's link, for the grid to move focus to after "Show all". */
  linkRef?: React.Ref<HTMLAnchorElement>;
};

/**
 * One beta video in the grid layout: thumbnail with a play mark on the left
 * (on top below md), the filmer's handle, the platform and "Watch the beta".
 *
 * A video with no thumbnail, or one whose thumbnail fails to load, keeps its
 * card: the frame becomes a plain play tile rather than a platform logo, so the
 * grid stays even and the link stays one tap away. The whole card is the link,
 * and its text is its accessible name.
 */
export default function BoardseshBetaGridCard({
  link,
  source,
  beyondPreview = false,
  linkRef,
}: BoardseshBetaGridCardProps) {
  const { t } = useTranslation('common');
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  // A cached failure can finish before hydration attaches onError. Inspect the
  // actual image when React attaches it so SSR failures get the same fallback.
  const checkThumbnail = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth === 0) setThumbnailFailed(true);
  }, []);
  const thumbnailSrc = thumbnailFailed ? null : link.thumbnail;
  const { displayPlatform, analyticsPlatform } = betaLinkPlatform(link.link);
  const handle = link.foreign_username ? `@${link.foreign_username}` : null;

  return (
    <Box component="li" className={styles.gridItem} data-beyond-preview={beyondPreview ? 'true' : undefined}>
      <Box
        component="a"
        ref={linkRef}
        href={link.link}
        target="_blank"
        // A filmer's own post: user content, so no endorsement passes with it.
        rel="ugc nofollow noopener noreferrer"
        className={styles.gridCard}
        onClick={() =>
          track('Beta Video Link Clicked', {
            platform: analyticsPlatform,
            climbUuid: link.climb_uuid,
            source,
            ...(link.foreign_username ? { foreignUsername: link.foreign_username } : {}),
          })
        }
      >
        <Box component="span" className={styles.gridThumb}>
          {thumbnailSrc ? (
            <Box
              component="img"
              ref={checkThumbnail}
              src={thumbnailSrc}
              alt=""
              className={styles.thumbnail}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setThumbnailFailed(true)}
            />
          ) : null}
          <Box component="span" className={styles.playMark} aria-hidden="true">
            <PlayArrowRounded fontSize="inherit" />
          </Box>
        </Box>
        <Box component="span" className={styles.gridText}>
          <Box component="span" className={styles.gridHandle}>
            {handle ?? displayPlatform}
          </Box>
          {handle ? (
            <Box component="span" className={styles.gridPlatform}>
              {displayPlatform}
            </Box>
          ) : null}
          <Box component="span" className={styles.gridWatch}>
            {t('betaVideos.watch')}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
