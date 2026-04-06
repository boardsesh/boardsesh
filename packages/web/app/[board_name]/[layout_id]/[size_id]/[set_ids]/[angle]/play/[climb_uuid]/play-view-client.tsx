'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import MuiButton from '@mui/material/Button';
import { useRouter, useSearchParams } from 'next/navigation';
import { track } from '@vercel/analytics';
import { Climb, BoardDetails, Angle } from '@/app/lib/types';
import { useQueueActions, useCurrentClimb, useQueueList } from '@/app/components/graphql-queue';
import SwipeBoardCarousel from '@/app/components/board-renderer/swipe-board-carousel';
import ClimbTitle from '@/app/components/climb-card/climb-title';
import { AscentStatus } from '@/app/components/climb-card/ascent-status';
import { constructClimbListWithSlugs, constructPlayUrlWithSlugs, extractUuidFromSlug } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { EmptyState } from '@/app/components/ui/empty-state';
import PlayViewBetaSlider from '@/app/components/play-view/play-view-beta-slider';
import PlayViewComments from '@/app/components/play-view/play-view-comments';
import styles from './play-view.module.css';

type PlayViewClientProps = {
  boardDetails: BoardDetails;
  initialClimb: Climb | null;
  angle: Angle;
};

const PlayViewClient: React.FC<PlayViewClientProps> = ({ boardDetails, initialClimb, angle }) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentClimb } = useCurrentClimb();
  const { queue } = useQueueList();
  const {
    setCurrentClimbQueueItem,
    getNextClimbQueueItem,
    getPreviousClimbQueueItem,
  } = useQueueActions();

  // Use queue's current climb if available (has real-time state like mirrored),
  // otherwise fall back to the initial climb from SSR.
  const displayClimb = currentClimb || initialClimb;

  // Get the mirrored state from currentClimb when it matches the displayed climb
  const isMirrored = currentClimb?.uuid === displayClimb?.uuid
    ? !!currentClimb?.mirrored
    : !!displayClimb?.mirrored;

  // Sync queue state with URL on browser back/forward navigation.
  // Uses refs to avoid re-subscribing the listener on every queue change.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const setCurrentClimbRef = useRef(setCurrentClimbQueueItem);
  setCurrentClimbRef.current = setCurrentClimbQueueItem;

  useEffect(() => {
    const handlePopState = () => {
      const pathSegments = window.location.pathname.split('/');
      const lastSegment = pathSegments[pathSegments.length - 1];
      if (!lastSegment) return;
      const uuid = extractUuidFromSlug(lastSegment);
      const item = queueRef.current.find(i => i.climb.uuid === uuid);
      if (item) {
        setCurrentClimbRef.current(item);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const getBackToListUrl = useCallback(() => {
    const { board_name, layout_name, size_name, size_description, set_names } = boardDetails;

    let baseUrl: string;
    if (layout_name && size_name && set_names) {
      baseUrl = constructClimbListWithSlugs(board_name, layout_name, size_name, size_description, set_names, angle);
    } else {
      baseUrl = `/${board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/list`;
    }

    const queryString = searchParams.toString();
    if (queryString) {
      return `${baseUrl}?${queryString}`;
    }
    return baseUrl;
  }, [boardDetails, angle, searchParams]);

  const navigateToClimb = useCallback(
    (climb: Climb) => {
      const { board_name, layout_name, size_name, size_description, set_names } = boardDetails;

      let url: string;
      if (layout_name && size_name && set_names) {
        url = constructPlayUrlWithSlugs(
          board_name,
          layout_name,
          size_name,
          size_description,
          set_names,
          angle,
          climb.uuid,
          climb.name,
        );
      } else {
        url = `/${board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/play/${climb.uuid}`;
      }

      const queryString = searchParams.toString();
      if (queryString) {
        url = `${url}?${queryString}`;
      }
      window.history.pushState(null, '', url);
    },
    [boardDetails, angle, searchParams],
  );

  const handleNext = useCallback(() => {
    const nextItem = getNextClimbQueueItem();
    if (nextItem) {
      setCurrentClimbQueueItem(nextItem);
      navigateToClimb(nextItem.climb);
      track('Play Mode Navigation', {
        direction: 'next',
        boardLayout: boardDetails.layout_name || '',
      });
    }
  }, [getNextClimbQueueItem, setCurrentClimbQueueItem, navigateToClimb, boardDetails.layout_name]);

  const handlePrevious = useCallback(() => {
    const prevItem = getPreviousClimbQueueItem();
    if (prevItem) {
      setCurrentClimbQueueItem(prevItem);
      navigateToClimb(prevItem.climb);
      track('Play Mode Navigation', {
        direction: 'previous',
        boardLayout: boardDetails.layout_name || '',
      });
    }
  }, [getPreviousClimbQueueItem, setCurrentClimbQueueItem, navigateToClimb, boardDetails.layout_name]);

  const nextItem = getNextClimbQueueItem();
  const prevItem = getPreviousClimbQueueItem();

  if (!displayClimb) {
    return (
      <div className={styles.pageContainer} style={{ backgroundColor: 'var(--semantic-background)' }}>
        <div className={styles.emptyState} style={{ color: 'var(--neutral-400)' }}>
          <EmptyState description="No climb selected" />
          <MuiButton variant="contained" onClick={() => router.push(getBackToListUrl())}>
            Browse Climbs
          </MuiButton>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pageContainer} style={{ backgroundColor: 'var(--semantic-background)' }}>
      {/* Main Content with Swipe */}
      <div className={styles.contentWrapper}>
        {/* Climb title - horizontal layout with grade on right */}
        <div
          className={styles.climbTitleContainer}
          style={{
            padding: `${themeTokens.spacing[1]}px ${themeTokens.spacing[3]}px`,
          }}
        >
          <ClimbTitle
            climb={displayClimb}
            layout="horizontal"
            showSetterInfo
            titleFontSize={themeTokens.typography.fontSize['2xl']}
            rightAddon={displayClimb && <AscentStatus climbUuid={displayClimb.uuid} fontSize={themeTokens.typography.fontSize['2xl']} />}
          />
        </div>
        <SwipeBoardCarousel
          boardDetails={boardDetails}
          currentClimb={{ frames: displayClimb.frames, mirrored: isMirrored }}
          nextClimb={nextItem?.climb}
          previousClimb={prevItem?.climb}
          onSwipeNext={handleNext}
          onSwipePrevious={handlePrevious}
          canSwipeNext={!!nextItem}
          canSwipePrevious={!!prevItem}
          className={styles.swipeContainer}
          boardContainerClassName={styles.boardContainer}
        />
      </div>

      {/* Beta videos & comments */}
      <div className={styles.extrasSection}>
        <PlayViewBetaSlider boardName={boardDetails.board_name} climbUuid={displayClimb.uuid} />
        <PlayViewComments climbUuid={displayClimb.uuid} />
      </div>
    </div>
  );
};

export default PlayViewClient;
