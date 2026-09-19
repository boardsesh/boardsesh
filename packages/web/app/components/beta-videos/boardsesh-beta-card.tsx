'use client';

import React, { useCallback, useState } from 'react';
import Instagram from '@mui/icons-material/Instagram';
import { track } from '@/app/lib/analytics';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { isInstagramUrl, isTikTokUrl } from '@/app/lib/beta-video-url';
import LocaleLink from '@/app/components/i18n/locale-link';
import TikTokIcon from './tiktok-icon';
import styles from './boardsesh-beta.module.css';

type BoardseshBetaCardSource = 'home' | 'drawer' | 'profile';

type BoardseshBetaCardProps = {
  link: BetaLink;
  /**
   * Optional climb label rendered as a top-anchored chip. Only the
   * home-screen slider passes this — the per-climb drawer slider omits it
   * because every card belongs to the same climb.
   */
  climbName?: string | null;
  /**
   * When provided alongside a climbName, the chip becomes a link to the
   * climb's view page. Falls back to a plain span when null.
   */
  climbHref?: string | null;
  /**
   * Surfaces where this card appears. Tagged on the analytics event so we
   * can measure CTR per placement.
   */
  source?: BoardseshBetaCardSource;
  /**
   * When true, this card's thumbnail is the Largest Contentful Paint element
   * (the first card of the above-the-fold home rail). Load it eagerly at high
   * priority instead of the default lazy — a lazy above-the-fold image is a
   * well-known LCP anti-pattern (the browser discovers it late and
   * deprioritizes the fetch). Only the first home-rail card sets this.
   */
  priority?: boolean;
};

const BoardseshBetaCard: React.FC<BoardseshBetaCardProps> = ({
  link,
  climbName,
  climbHref,
  source = 'drawer',
  priority = false,
}) => {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  // A cached failure can finish before hydration attaches onError. Inspect the
  // actual image when React attaches it so SSR failures get the same fallback.
  const checkThumbnail = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth === 0) setThumbnailFailed(true);
  }, []);
  const thumbnailSrc = !thumbnailFailed ? link.thumbnail : null;
  const isTikTok = isTikTokUrl(link.link);
  const isInstagram = !isTikTok && isInstagramUrl(link.link);
  const PlatformIcon = isTikTok ? TikTokIcon : Instagram;
  const displayPlatform = isTikTok ? 'TikTok' : 'Instagram';
  let analyticsPlatform: 'TikTok' | 'Instagram' | 'Unknown' = 'Unknown';
  if (isTikTok) {
    analyticsPlatform = 'TikTok';
  } else if (isInstagram) {
    analyticsPlatform = 'Instagram';
  }

  const climbLabel = climbName?.trim() ? climbName : null;
  const climbHrefEffective = climbLabel && climbHref ? climbHref : null;
  const ariaLabel =
    `Open beta on ${displayPlatform}` +
    (link.foreign_username ? ` by ${link.foreign_username}` : '') +
    (climbLabel ? ` for ${climbLabel}` : '');

  return (
    <article className={styles.card}>
      <div className={styles.thumbnailWrapper}>
        <a
          href={link.link}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.bodyLink}
          aria-label={ariaLabel}
          onClick={() =>
            track('Beta Video Link Clicked', {
              platform: analyticsPlatform,
              climbUuid: link.climb_uuid,
              source,
              ...(link.foreign_username ? { foreignUsername: link.foreign_username } : {}),
            })
          }
        >
          {thumbnailSrc ? (
            <img
              ref={checkThumbnail}
              src={thumbnailSrc}
              alt={`Beta by ${link.foreign_username || 'unknown'}`}
              className={styles.thumbnail}
              loading={priority ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : undefined}
              referrerPolicy="no-referrer"
              onError={() => setThumbnailFailed(true)}
            />
          ) : (
            <div className={styles.thumbnailPlaceholder}>
              <PlatformIcon sx={{ fontSize: 28, color: 'var(--neutral-400)' }} />
            </div>
          )}
          <span className={styles.platformBadge} aria-label={`From ${displayPlatform}`}>
            <PlatformIcon sx={{ fontSize: 12 }} />
          </span>
          {link.foreign_username && <span className={styles.userChip}>@{link.foreign_username}</span>}
        </a>
        {climbLabel &&
          (climbHrefEffective ? (
            <LocaleLink
              href={climbHrefEffective}
              prefetch={false}
              className={styles.climbChip}
              aria-label={`View climb ${climbLabel}`}
              onClick={() =>
                track('Beta Video Climb Clicked', {
                  platform: analyticsPlatform,
                  climbUuid: link.climb_uuid,
                  source,
                })
              }
            >
              {climbLabel}
            </LocaleLink>
          ) : (
            <span className={styles.climbChip}>{climbLabel}</span>
          ))}
      </div>
    </article>
  );
};

export default BoardseshBetaCard;
