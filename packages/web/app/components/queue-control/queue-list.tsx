'use client';
import React, { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef, useMemo } from 'react';
import Skeleton from '@mui/material/Skeleton';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import { useQueueActions, useCurrentClimb, useQueueList, useSearchData, useSessionData } from '../graphql-queue';
import { Climb, BoardDetails } from '@/app/lib/types';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { reorder } from '@atlaskit/pragmatic-drag-and-drop/reorder';
import QueueClimbListItem from './queue-climb-list-item';
import ClimbListItem from '../climb-card/climb-list-item';
import { themeTokens } from '@/app/theme/theme-config';
import { SUGGESTIONS_THRESHOLD } from '../board-page/constants';
import { useOptionalBoardProvider } from '../board-provider/board-provider-context';
import { LogAscentDrawer } from '../logbook/log-ascent-drawer';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import styles from './queue-list.module.css';


export type QueueListHandle = {
  scrollToCurrentClimb: () => void;
};

type QueueListProps = {
  boardDetails: BoardDetails;
  onClimbNavigate?: () => void;
  isEditMode?: boolean;
  showHistory?: boolean;
  selectedItems?: Set<string>;
  onToggleSelect?: (uuid: string) => void;
  scrollContainer?: HTMLElement | null;
};

const QueueList = forwardRef<QueueListHandle, QueueListProps>(({ boardDetails, onClimbNavigate, isEditMode = false, showHistory = false, selectedItems, onToggleSelect, scrollContainer }, ref) => {
  const { currentClimbQueueItem } = useCurrentClimb();
  const { queue, suggestedClimbs } = useQueueList();
  const { hasMoreResults, isFetchingClimbs, isFetchingNextPage } = useSearchData();
  const { viewOnlyMode } = useSessionData();
  const {
    fetchMoreClimbs,
    setCurrentClimbQueueItem,
    setQueue,
    addToQueue,
  } = useQueueActions();

  const isAuthenticated = useOptionalBoardProvider()?.isAuthenticated ?? false;

  // Tick drawer state
  const [tickDrawerVisible, setTickDrawerVisible] = useState(false);
  const [tickClimb, setTickClimb] = useState<Climb | null>(null);
  const { openAuthModal } = useAuthModal();

  // Ref for scrolling to position that shows only 2 history items above current
  const scrollTargetRef = useRef<HTMLDivElement>(null);

  // Expose scroll method to parent via ref
  useImperativeHandle(ref, () => ({
    scrollToCurrentClimb: () => {
      if (scrollTargetRef.current) {
        scrollTargetRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
  }));

  const handleTickClick = useCallback((climb: Climb) => {
    setTickClimb(climb);
    setTickDrawerVisible(true);
  }, []);

  const closeTickDrawer = useCallback(() => {
    setTickDrawerVisible(false);
    setTickClimb(null);
  }, []);

  // Monitor for drag-and-drop events
  useEffect(() => {
    if (isEditMode) return;

    const cleanup = monitorForElements({
      onDrop({ location, source }) {
        const target = location.current.dropTargets[0];
        if (!target) return;

        const sourceIndex = Number(source.data.index);
        const targetIndex = Number(target.data.index);

        if (isNaN(sourceIndex) || isNaN(targetIndex)) return;

        const edge = extractClosestEdge(target.data);
        let finalIndex = edge === 'bottom' ? targetIndex + 1 : targetIndex;

        // Adjust for the fact that removing the source item shifts indices
        if (sourceIndex < finalIndex) {
          finalIndex = finalIndex - 1;
        }

        const newQueue = reorder({
          list: queue,
          startIndex: sourceIndex,
          finishIndex: finalIndex,
        });

        setQueue(newQueue);
      },
    });

    return cleanup; // Cleanup listener on component unmount
  }, [queue, setQueue, isEditMode]);

  // Ref for the intersection observer sentinel element
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Refs for observer callback values — prevents observer recreation on every page load
  const fetchMoreClimbsRef = useRef(fetchMoreClimbs);
  const hasMoreResultsRef = useRef(hasMoreResults);
  const isFetchingNextPageRef = useRef(isFetchingNextPage);
  const suggestedClimbsLengthRef = useRef(suggestedClimbs.length);
  fetchMoreClimbsRef.current = fetchMoreClimbs;
  hasMoreResultsRef.current = hasMoreResults;
  isFetchingNextPageRef.current = isFetchingNextPage;
  suggestedClimbsLengthRef.current = suggestedClimbs.length;

  // Intersection Observer callback for infinite scroll — stable ref, never recreated
  // Skip if suggestions are below threshold - proactive fetch in QueueContext handles that case
  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [target] = entries;
      if (
        target.isIntersecting &&
        hasMoreResultsRef.current &&
        !isFetchingNextPageRef.current &&
        suggestedClimbsLengthRef.current >= SUGGESTIONS_THRESHOLD
      ) {
        fetchMoreClimbsRef.current();
      }
    },
    [],
  );

  // Set up Intersection Observer for infinite scroll
  // Uses scrollContainerRef as root when provided (for nested scroll containers like drawers/sidebars),
  // falls back to null (viewport) for top-level scrolling
  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || viewOnlyMode) return;

    const observer = new IntersectionObserver(handleObserver, {
      root: scrollContainer ?? null,
      rootMargin: '100px',
      threshold: 0,
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [handleObserver, viewOnlyMode, scrollContainer]);

  // Find the index of the current climb in the queue
  const currentIndex = queue.findIndex((item) => item.uuid === currentClimbQueueItem?.uuid);

  // Split queue into history (past), current, and future items
  // Rendered in Spotify-like order: history (oldest to newest) → current → future
  const historyItems = currentIndex > 0 ? queue.slice(0, currentIndex) : [];
  // When no current climb (currentIndex === -1), show entire queue as future items
  const futureItems = currentIndex >= 0 ? queue.slice(currentIndex + 1) : queue;

  // Calculate which history item to scroll to:
  // Show only 2 history items above current, so scroll target is at index (length - 2)
  const scrollToHistoryIndex = historyItems.length > 2 ? historyItems.length - 2 : 0;

  // Memoize suggested item title props — match queue item layout (grade on right)
  const suggestedTitleProps = useMemo(
    () => ({ gradePosition: 'right' as const, showSetterInfo: true, titleFontSize: themeTokens.typography.fontSize.xl }),
    [],
  );

  const loadMoreContainerStyle = useMemo(
    () => ({
      minHeight: themeTokens.spacing[5],
      marginTop: themeTokens.spacing[2],
    }),
    [],
  );

  const loadMoreSkeletonStyle = useMemo(
    () => ({
      gap: `${themeTokens.spacing[2]}px`,
      padding: `${themeTokens.spacing[2]}px`,
    }),
    [],
  );


  return (
    <>
      <div className={styles.queueColumn}>
        {/* History items (oldest to newest at top) - only shown when showHistory is true */}
        {showHistory && historyItems.length > 0 && (
          <>
            {historyItems.map((climbQueueItem, index) => {
              // Calculate original queue index for drag-and-drop
              // historyItems = queue.slice(0, currentIndex), so original index equals map index
              const originalIndex = index;
              // Add scroll target ref at the position that shows only 2 history items
              const isScrollTarget = historyItems.length > 2 && index === scrollToHistoryIndex;

              return (
                <div key={climbQueueItem.uuid} ref={isScrollTarget ? scrollTargetRef : undefined}>
                  <QueueClimbListItem
                    item={climbQueueItem}
                    index={originalIndex}
                    isCurrent={false}
                    isHistory={true}
                    boardDetails={boardDetails}
                    setCurrentClimbQueueItem={setCurrentClimbQueueItem}
                    onTickClick={handleTickClick}
                    isEditMode={isEditMode}
                    isSelected={selectedItems?.has(climbQueueItem.uuid) ?? false}
                    onToggleSelect={onToggleSelect}
                  />
                </div>
              );
            })}
            <MuiDivider className={styles.historyDivider} />
          </>
        )}

        {/* Current climb item */}
        {currentClimbQueueItem && (
          <div key={currentClimbQueueItem.uuid} ref={!showHistory || historyItems.length <= 2 ? scrollTargetRef : undefined}>
            <QueueClimbListItem
              item={currentClimbQueueItem}
              index={currentIndex}
              isCurrent={true}
              isHistory={false}
              boardDetails={boardDetails}
              setCurrentClimbQueueItem={setCurrentClimbQueueItem}
              onTickClick={handleTickClick}
              isEditMode={isEditMode}
              isSelected={selectedItems?.has(currentClimbQueueItem.uuid) ?? false}
              onToggleSelect={onToggleSelect}
            />
          </div>
        )}

        {/* Future items (after current) */}
        {futureItems.map((climbQueueItem, index) => {
          // Calculate original index: future items start after current climb
          const originalIndex = currentIndex >= 0 ? currentIndex + 1 + index : index;
          // Attach scroll target to first future item if there's no current climb
          // and history has 2 or fewer items (scrollTargetRef wouldn't be attached elsewhere)
          const isScrollTarget = index === 0 && !currentClimbQueueItem && (!showHistory || historyItems.length <= 2);

          return (
            <div key={climbQueueItem.uuid} ref={isScrollTarget ? scrollTargetRef : undefined}>
              <QueueClimbListItem
                item={climbQueueItem}
                index={originalIndex}
                isCurrent={false}
                isHistory={false}
                boardDetails={boardDetails}
                setCurrentClimbQueueItem={setCurrentClimbQueueItem}
                onTickClick={handleTickClick}
                isEditMode={isEditMode}
                isSelected={selectedItems?.has(climbQueueItem.uuid) ?? false}
                onToggleSelect={onToggleSelect}
              />
            </div>
          );
        })}
      </div>
      {!viewOnlyMode && (
        <>
          <div className={styles.suggestedSectionHeader}>
            <Typography variant="overline" color="text.secondary">
              Suggestions
            </Typography>
          </div>
          <div className={styles.suggestedColumn}>
            {suggestedClimbs.map((climb: Climb) => (
              <div key={`suggested-${climb.uuid}`} className={styles.suggestedItem}>
                <ClimbListItem
                  climb={climb}
                  boardDetails={boardDetails}
                  titleProps={suggestedTitleProps}
                  onNavigate={onClimbNavigate}
                  addToQueue={addToQueue}
                />
              </div>
            ))}
          </div>
          {/* Sentinel element for Intersection Observer - only render when needed */}
          {/* Include isFetchingClimbs to show skeleton during initial page load */}
          {(suggestedClimbs.length > 0 || isFetchingClimbs || isFetchingNextPage || hasMoreResults) && (
            <div
              ref={loadMoreRef}
              style={loadMoreContainerStyle}
            >
              {(isFetchingClimbs || isFetchingNextPage) && (
                <div
                  className={styles.loadMoreContainer}
                  style={loadMoreSkeletonStyle}
                >
                  {[1, 2, 3].map((i) => (
                    <div key={i} className={styles.loadMoreSkeletonRow}>
                      <Skeleton variant="rectangular" width={64} height={60} animation="wave" sx={{ flexShrink: 0 }} />
                      <Skeleton variant="text" animation="wave" sx={{ flex: 1 }} />
                      <Skeleton variant="rectangular" width={32} height={32} animation="wave" sx={{ flexShrink: 0 }} />
                    </div>
                  ))}
                </div>
              )}
              {!hasMoreResults && !isFetchingClimbs && suggestedClimbs.length > 0 && (
                <div className={styles.noMoreSuggestions}>
                  <Typography variant="body2" color="text.disabled">
                    That's all for now
                  </Typography>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Tick drawer - now works with just NextAuth authentication */}
      {isAuthenticated ? (
        <LogAscentDrawer
          open={tickDrawerVisible}
          onClose={closeTickDrawer}
          currentClimb={tickClimb}
          boardDetails={boardDetails}
        />
      ) : (
        <SwipeableDrawer
          title="Sign In Required"
          placement="bottom"
          onClose={closeTickDrawer}
          open={tickDrawerVisible}
          styles={{ wrapper: { height: '50%' } }}
        >
          <Stack spacing={3} sx={{ width: '100%', textAlign: 'center', padding: `${themeTokens.spacing[6]}px 0` }}>
            <Typography variant="body2" component="span" fontWeight={600} sx={{ fontSize: themeTokens.typography.fontSize.base }}>Sign in to record ticks</Typography>
            <Typography variant="body1" component="p" color="text.secondary">
              Create a Boardsesh account to log your climbs and track your progress.
            </Typography>
            <Button variant="contained" startIcon={<LoginOutlined />} onClick={() => openAuthModal({ title: 'Sign in to record ticks', description: 'Create an account to log your climbs and track your progress.' })} fullWidth>
              Sign In
            </Button>
          </Stack>
        </SwipeableDrawer>
      )}

    </>
  );
});

QueueList.displayName = 'QueueList';

export default QueueList;
