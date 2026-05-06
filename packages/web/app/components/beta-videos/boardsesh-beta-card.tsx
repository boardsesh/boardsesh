'use client';

import React, { useState } from 'react';
import Instagram from '@mui/icons-material/Instagram';
import { track } from '@/app/lib/analytics';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { isInstagramUrl, isTikTokUrl } from '@/app/lib/beta-video-url';
import TikTokIcon from './tiktok-icon';
import styles from './boardsesh-beta.module.css';

type BoardseshBetaCardProps = {
  link: BetaLink;
};

const BoardseshBetaCard: React.FC<BoardseshBetaCardProps> = ({ link }) => {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
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

  return (
    <a
      href={link.link}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.card}
      aria-label={`Open beta on ${displayPlatform}${link.foreign_username ? ` by ${link.foreign_username}` : ''}`}
      onClick={() =>
        track('Beta Video Link Clicked', {
          platform: analyticsPlatform,
          climbUuid: link.climb_uuid,
          ...(link.foreign_username ? { foreignUsername: link.foreign_username } : {}),
        })
      }
    >
      <div className={styles.thumbnailWrapper}>
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={`Beta by ${link.foreign_username || 'unknown'}`}
            className={styles.thumbnail}
            loading="lazy"
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
      </div>
    </a>
  );
};

export default BoardseshBetaCard;
