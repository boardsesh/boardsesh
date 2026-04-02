'use client';

import React, { useMemo } from 'react';
import IconButton from '@mui/material/IconButton';
import MuiBadge from '@mui/material/Badge';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import Favorite from '@mui/icons-material/Favorite';
import SkipPreviousOutlined from '@mui/icons-material/SkipPreviousOutlined';
import SkipNextOutlined from '@mui/icons-material/SkipNextOutlined';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import SwipeBoardCarousel from '../board-renderer/swipe-board-carousel';
import ClimbDetailHeader from '@/app/components/climb-detail/climb-detail-header';
import { useFavorite, ClimbActions } from '../climb-actions';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { useQueueContext } from '../graphql-queue';
import { ShareBoardButton } from '../board-page/share-button';
import { usePathname } from 'next/navigation';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails, Climb } from '@/app/lib/types';
import styles from './play-view-drawer.module.css';

interface PlayClimbAboveFoldProps {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
  onOpenActions?: () => void;
  onOpenQueue?: () => void;
  onOpenTick?: () => void;
  showPrevNextButtons?: boolean;
}

export default function PlayClimbAboveFold({
  climb,
  boardDetails,
  angle,
  onOpenActions,
  onOpenQueue,
  onOpenTick,
  showPrevNextButtons = true,
}: PlayClimbAboveFoldProps) {
  const {
    mirrorClimb,
    getNextClimbQueueItem,
    getPreviousClimbQueueItem,
    setCurrentClimbQueueItem,
    currentClimbQueueItem,
    queue,
    viewOnlyMode,
  } = useQueueContext();
  const pathname = usePathname();
  const { logbook } = useBoardProvider();

  const { isFavorited, toggleFavorite } = useFavorite({
    climbUuid: climb.uuid,
  });

  const nextItem = getNextClimbQueueItem();
  const prevItem = getPreviousClimbQueueItem();
  const canSwipeNext = !viewOnlyMode && !!nextItem;
  const canSwipePrevious = !viewOnlyMode && !!prevItem;
  const isMirrored = !!climb?.mirrored;

  const currentQueueIndex = currentClimbQueueItem
    ? queue.findIndex(item => item.uuid === currentClimbQueueItem.uuid)
    : -1;
  const remainingQueueCount = currentQueueIndex >= 0 ? queue.length - currentQueueIndex : queue.length;

  const filteredLogbook = useMemo(() => {
    if (!logbook || !climb) return [];
    return logbook.filter((asc) => asc.climb_uuid === climb.uuid && Number(asc.angle) === angle);
  }, [logbook, climb, angle]);

  const hasSuccessfulAscent = filteredLogbook.some((asc) => asc.is_ascent);
  const ascentCount = filteredLogbook.length;

  return (
    <>
      <div className={styles.headerSection}>
        <ClimbDetailHeader
          climb={climb}
          boardDetails={boardDetails}
          angle={angle}
          isAngleAdjustable={true}
        />
      </div>

      <div className={styles.boardSectionWrapper}>
        <SwipeBoardCarousel
          boardDetails={boardDetails}
          currentClimb={climb}
          nextClimb={nextItem?.climb}
          previousClimb={prevItem?.climb}
          onSwipeNext={() => {
            const next = getNextClimbQueueItem();
            if (next && !viewOnlyMode) setCurrentClimbQueueItem(next);
          }}
          onSwipePrevious={() => {
            const prev = getPreviousClimbQueueItem();
            if (prev && !viewOnlyMode) setCurrentClimbQueueItem(prev);
          }}
          canSwipeNext={canSwipeNext}
          canSwipePrevious={canSwipePrevious}
          className={styles.boardSection}
          boardContainerClassName={styles.swipeCardContainer}
          fillContainer
        />

        <div className={styles.tickFabContainer}>
          <button
            className={`${styles.tickFab} ${hasSuccessfulAscent ? styles.tickFabSuccess : ''}`}
            onClick={onOpenTick}
            aria-label="Log ascent"
          >
            <CheckOutlined className={styles.tickFabIcon} />
            {ascentCount > 0 && (
              <span className={styles.tickFabBadge}>{ascentCount}</span>
            )}
          </button>
        </div>
      </div>

      <div className={styles.actionBar}>
        {showPrevNextButtons && (
          <IconButton
            disabled={!canSwipePrevious}
            onClick={() => {
              const prev = getPreviousClimbQueueItem();
              if (prev) setCurrentClimbQueueItem(prev);
            }}
          >
            <SkipPreviousOutlined />
          </IconButton>
        )}

        {boardDetails.supportsMirroring && (
          <IconButton
            color={isMirrored ? 'primary' : 'default'}
            onClick={() => mirrorClimb()}
            sx={
              isMirrored
                ? { backgroundColor: themeTokens.colors.purple, borderColor: themeTokens.colors.purple, color: 'common.white', '&:hover': { backgroundColor: themeTokens.colors.purple } }
                : undefined
            }
          >
            <SyncOutlined />
          </IconButton>
        )}

        <IconButton onClick={() => toggleFavorite()}>
          {isFavorited ? <Favorite sx={{ color: themeTokens.colors.error }} /> : <FavoriteBorderOutlined />}
        </IconButton>

        <ClimbActions
          climb={climb}
          boardDetails={boardDetails}
          angle={angle}
          currentPathname={pathname}
          viewMode="button"
          include={['share']}
          size="default"
        />

        <ShareBoardButton />

        {onOpenActions && (
          <IconButton onClick={onOpenActions} aria-label="Climb actions">
            <MoreHorizOutlined />
          </IconButton>
        )}

        {onOpenQueue && (
          <MuiBadge badgeContent={remainingQueueCount} max={99} sx={{ '& .MuiBadge-badge': { backgroundColor: themeTokens.colors.primary, color: 'common.white' } }}>
            <IconButton onClick={onOpenQueue} aria-label="Open queue">
              <FormatListBulletedOutlined />
            </IconButton>
          </MuiBadge>
        )}

        {showPrevNextButtons && (
          <IconButton
            disabled={!canSwipeNext}
            onClick={() => {
              const next = getNextClimbQueueItem();
              if (next) setCurrentClimbQueueItem(next);
            }}
          >
            <SkipNextOutlined />
          </IconButton>
        )}
      </div>
    </>
  );
}
