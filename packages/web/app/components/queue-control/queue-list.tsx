'use client';
import React, { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Skeleton from '@mui/material/Skeleton';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import drawerCss from '../swipeable-drawer/swipeable-drawer.module.css';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import { useQueueActions, useCurrentClimbUuid, useQueueList, useSearchData, useSessionData } from '../graphql-queue';
import { Climb, BoardDetails } from '@/app/lib/types';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { reorder } from '@atlaskit/pragmatic-drag-and-drop/reorder';
import { usePathname, useRouter, useParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import QueueClimbListItem from './queue-climb-list-item';
import { dispatchOpenPlayDrawer } from './play-drawer-event';
import ClimbListItem from '../climb-card/climb-list-item';
import DrawerClimbHeader from '../climb-card/drawer-climb-header';
import { ClimbActions } from '../climb-actions';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { useOptionalBoardProvider } from '../board-provider/board-provider-context';
import { LogAscentDrawer } from '../logbook/log-ascent-drawer';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { ClimbQueueItem } from './types';
import { isClimbEditable } from './is-climb-editable';
import styles from './queue-list.module.css';

// Discriminated union for all possible rows in the flat virtualized list
type FlatRow =
  | { type: 'history-item'; item: ClimbQueueItem; queueIndex: number }
  | { type: 'history-divider' }
  | { type: 'current-item'; item: ClimbQueueItem; queueIndex: number }
  | { type: 'future-item'; item: ClimbQueueItem; queueIndex: number }
  | { type: 'suggestion-header' }
  | { type: 'suggestion'; climb: Climb }
  | { type: 'loading' }
  | { type: 'end-message' };

export type QueueListHandle = {
  scrollToCurrentClimb: () => void;
};

type QueueListProps = {
  boardDetails: BoardDetails;
  isEditMode?: boolean;
  showHistory?: boolean;
  selectedItems?: Set<string>;
  onToggleSelect?: (uuid: string) => void;
  scrollContainer?: HTMLElement | null;
  /** When false, suggested climbs and infinite scroll are not rendered.
   *  Use this when QueueList is inside a closed keepMounted drawer. */
  active?: boolean;
};

const QueueList = forwardRef<QueueListHandle, QueueListProps>(
  (
    {
      boardDetails,
      isEditMode = false,
      showHistory = false,
      selectedItems,
      onToggleSelect,
      scrollContainer,
      active = true,
    },
    ref,
  ) => {
    const currentClimbUuid = useCurrentClimbUuid();
    const { queue, suggestedClimbs } = useQueueList();
    const { hasMoreResults, isFetchingClimbs, isFetchingNextPage } = useSearchData();
    const { viewOnlyMode } = useSessionData();
    const { setCurrentClimb, setCurrentClimbQueueItem, setQueue, addToQueue } = useQueueActions();
    const pathname = usePathname();
    const router = useRouter();
    const routeParams = useParams<{ board_slug?: string; angle?: string }>();
    const { data: authSession } = useSession();
    const isDark = useIsDarkMode();

    // Gate the Edit affordance on ownership (by immutable userId), draft or
    // in-window status, and whether we're on a board-slug-shaped route.
    const currentUserId = authSession?.user?.id ?? null;
    const boardSlug = routeParams?.board_slug;
    const angleParam = routeParams?.angle;
    const hasBoardRoute = !!(boardSlug && angleParam);
    const canEditClimb = useCallback(
      (climb: Climb): boolean => isClimbEditable(climb, { currentUserId, hasBoardRoute }),
      [currentUserId, hasBoardRoute],
    );

    const handleEditClimb = useCallback(
      (climb: Climb) => {
        if (!boardSlug || !angleParam) return;
        router.push(`/b/${boardSlug}/${angleParam}/create?editClimbUuid=${climb.uuid}`);
      },
      [router, boardSlug, angleParam],
    );

    const isAuthenticated = useOptionalBoardProvider()?.isAuthenticated ?? false;

    // Tick drawer state
    const [tickDrawerVisible, setTickDrawerVisible] = useState(false);
    const [tickClimb, setTickClimb] = useState<Climb | null>(null);
    const { openAuthModal } = useAuthModal();

    // Shared drawer state — one actions drawer and one playlist drawer for all items.
    // This replaces the per-ClimbListItem drawers (previously 100+ drawer trees).
    const [actionsClimb, setActionsClimb] = useState<Climb | null>(null);
    const [playlistClimb, setPlaylistClimb] = useState<Climb | null>(null);

    const handleOpenActions = useCallback((climb: Climb) => {
      setPlaylistClimb(null);
      setActionsClimb(climb);
    }, []);
    const handleOpenPlaylistSelector = useCallback((climb: Climb) => {
      setActionsClimb(null);
      setPlaylistClimb(climb);
    }, []);
    const handleCloseActions = useCallback(() => setActionsClimb(null), []);
    const handleOpenPlaylistFromActions = useCallback(() => {
      setActionsClimb(null);
      setPlaylistClimb(actionsClimb);
    }, [actionsClimb]);
    const handleClosePlaylist = useCallback(() => setPlaylistClimb(null), []);

    const { paperRef: actionsPaperRef, dragHandlers: actionsDragHandlers } = useDrawerDragResize({
      open: !!actionsClimb,
      onClose: handleCloseActions,
    });

    // Since the user is already in the queue list, "go to queue" just closes the actions drawer
    const handleGoToQueue = useCallback(() => {
      handleCloseActions();
    }, [handleCloseActions]);

    // Suggested climbs: clicking the thumbnail promotes the climb to current
    // (which also adds it to the queue) and opens the play drawer, matching
    // the behavior of queue items and board list items.
    const handleSuggestionThumbnailClick = useCallback(
      (climb: Climb) => {
        setCurrentClimb(climb);
        dispatchOpenPlayDrawer();
      },
      [setCurrentClimb],
    );

    const excludeActions = useMemo(
      () => getExcludedClimbActions(boardDetails.board_name, 'list'),
      [boardDetails.board_name],
    );

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

      return cleanup;
    }, [queue, setQueue, isEditMode]);

    // Memoize suggested item title props — match queue item layout (grade on right)
    const suggestedTitleProps = useMemo(
      () => ({
        gradePosition: 'right' as const,
        showSetterInfo: true,
        titleFontSize: themeTokens.typography.fontSize.xl,
      }),
      [],
    );

    // Build the flat row model for the unified virtualizer
    const { flatRows, scrollTargetFlatIndex } = useMemo(() => {
      const rows: FlatRow[] = [];
      let scrollTargetIdx = -1;

      const currentIndex = queue.findIndex((item) => item.uuid === currentClimbUuid);
      const historyItems = currentIndex > 0 ? queue.slice(0, currentIndex) : [];
      const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
      // When no current climb (currentIndex === -1), show entire queue as future items
      const futureItems = currentIndex >= 0 ? queue.slice(currentIndex + 1) : queue;

      // History items
      if (showHistory && historyItems.length > 0) {
        const scrollToHistoryIndex = historyItems.length > 2 ? historyItems.length - 2 : 0;
        for (let i = 0; i < historyItems.length; i++) {
          if (historyItems.length > 2 && i === scrollToHistoryIndex) {
            scrollTargetIdx = rows.length;
          }
          rows.push({ type: 'history-item', item: historyItems[i], queueIndex: i });
        }
        rows.push({ type: 'history-divider' });
      }

      // Current item
      if (currentItem) {
        if (!showHistory || historyItems.length <= 2) {
          scrollTargetIdx = rows.length;
        }
        rows.push({ type: 'current-item', item: currentItem, queueIndex: currentIndex });
      }

      // Future items
      for (let i = 0; i < futureItems.length; i++) {
        const originalIndex = currentIndex >= 0 ? currentIndex + 1 + i : i;
        if (i === 0 && !currentItem && (!showHistory || historyItems.length <= 2)) {
          scrollTargetIdx = rows.length;
        }
        rows.push({ type: 'future-item', item: futureItems[i], queueIndex: originalIndex });
      }

      // Suggestions section (only when active and not viewOnlyMode)
      if (active && !viewOnlyMode) {
        rows.push({ type: 'suggestion-header' });
        for (let i = 0; i < suggestedClimbs.length; i++) {
          rows.push({ type: 'suggestion', climb: suggestedClimbs[i] });
        }
        // Loading or end message
        if (suggestedClimbs.length > 0 || isFetchingClimbs || isFetchingNextPage) {
          if (isFetchingClimbs || isFetchingNextPage) {
            rows.push({ type: 'loading' });
          } else if (!hasMoreResults && suggestedClimbs.length > 0) {
            rows.push({ type: 'end-message' });
          }
        }
      }

      return { flatRows: rows, scrollTargetFlatIndex: scrollTargetIdx };
    }, [
      queue,
      currentClimbUuid,
      showHistory,
      suggestedClimbs,
      active,
      viewOnlyMode,
      hasMoreResults,
      isFetchingClimbs,
      isFetchingNextPage,
    ]);

    const loadMoreSkeletonStyle = useMemo(
      () => ({
        gap: `${themeTokens.spacing[2]}px`,
        padding: `${themeTokens.spacing[2]}px`,
      }),
      [],
    );

    // Unified virtualizer for the entire list
    const virtualizer = useVirtualizer({
      count: flatRows.length,
      getScrollElement: () => scrollContainer ?? null,
      estimateSize: (index) => {
        const row = flatRows[index];
        if (!row) return 102;
        switch (row.type) {
          case 'history-divider':
            return 17;
          case 'suggestion-header':
            return 36;
          case 'loading':
            return 220;
          case 'end-message':
            return 52;
          default:
            return 102;
        }
      },
      overscan: 10,
      getItemKey: (index) => {
        const row = flatRows[index];
        if (!row) return index;
        switch (row.type) {
          case 'history-item':
          case 'current-item':
          case 'future-item':
            return `q-${row.item.uuid}`;
          case 'suggestion':
            return `s-${row.climb.uuid}`;
          case 'history-divider':
            return 'divider';
          case 'suggestion-header':
            return 'suggestion-header';
          case 'loading':
            return 'loading';
          case 'end-message':
            return 'end-message';
        }
      },
    });

    // Store virtualizer in a ref for the imperative handle
    const virtualizerRef = useRef(virtualizer);
    virtualizerRef.current = virtualizer;

    // Expose scroll method to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        scrollToCurrentClimb: () => {
          if (scrollTargetFlatIndex >= 0) {
            virtualizerRef.current.scrollToIndex(scrollTargetFlatIndex, {
              align: 'start',
              behavior: 'smooth',
            });
          }
        },
      }),
      [scrollTargetFlatIndex],
    );

    return (
      <>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const row = flatRows[virtualItem.index];
            if (!row) return null;

            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                  contain: 'layout style paint',
                }}
              >
                {row.type === 'history-item' && (
                  <QueueClimbListItem
                    item={row.item}
                    index={row.queueIndex}
                    isCurrent={false}
                    isHistory={true}
                    boardDetails={boardDetails}
                    pathname={pathname}
                    isDark={isDark}
                    setCurrentClimbQueueItem={setCurrentClimbQueueItem}
                    onTickClick={handleTickClick}
                    onOpenActions={handleOpenActions}
                    onOpenPlaylistSelector={handleOpenPlaylistSelector}
                    isEditMode={isEditMode}
                    isSelected={selectedItems?.has(row.item.uuid) ?? false}
                    onToggleSelect={onToggleSelect}
                    onEditClimb={handleEditClimb}
                    isEditable={canEditClimb(row.item.climb)}
                  />
                )}
                {row.type === 'history-divider' && <MuiDivider className={styles.historyDivider} />}
                {row.type === 'current-item' && (
                  <QueueClimbListItem
                    item={row.item}
                    index={row.queueIndex}
                    isCurrent={true}
                    isHistory={false}
                    boardDetails={boardDetails}
                    pathname={pathname}
                    isDark={isDark}
                    setCurrentClimbQueueItem={setCurrentClimbQueueItem}
                    onTickClick={handleTickClick}
                    onOpenActions={handleOpenActions}
                    onOpenPlaylistSelector={handleOpenPlaylistSelector}
                    isEditMode={isEditMode}
                    isSelected={selectedItems?.has(row.item.uuid) ?? false}
                    onToggleSelect={onToggleSelect}
                    onEditClimb={handleEditClimb}
                    isEditable={canEditClimb(row.item.climb)}
                  />
                )}
                {row.type === 'future-item' && (
                  <QueueClimbListItem
                    item={row.item}
                    index={row.queueIndex}
                    isCurrent={false}
                    isHistory={false}
                    boardDetails={boardDetails}
                    pathname={pathname}
                    isDark={isDark}
                    setCurrentClimbQueueItem={setCurrentClimbQueueItem}
                    onTickClick={handleTickClick}
                    onOpenActions={handleOpenActions}
                    onOpenPlaylistSelector={handleOpenPlaylistSelector}
                    isEditMode={isEditMode}
                    isSelected={selectedItems?.has(row.item.uuid) ?? false}
                    onToggleSelect={onToggleSelect}
                    onEditClimb={handleEditClimb}
                    isEditable={canEditClimb(row.item.climb)}
                  />
                )}
                {row.type === 'suggestion-header' && (
                  <div className={styles.suggestedSectionHeader}>
                    <Typography variant="overline" color="text.secondary">
                      Suggestions
                    </Typography>
                  </div>
                )}
                {row.type === 'suggestion' && (
                  <ClimbListItem
                    climb={row.climb}
                    boardDetails={boardDetails}
                    pathname={pathname}
                    isDark={isDark}
                    titleProps={suggestedTitleProps}
                    onThumbnailClick={() => handleSuggestionThumbnailClick(row.climb)}
                    onOpenActions={handleOpenActions}
                    onOpenPlaylistSelector={handleOpenPlaylistSelector}
                    addToQueue={addToQueue}
                  />
                )}
                {row.type === 'loading' && (
                  <div className={styles.loadMoreContainer} style={loadMoreSkeletonStyle}>
                    {[1, 2, 3].map((i) => (
                      <div key={i} className={styles.loadMoreSkeletonRow}>
                        <Skeleton
                          variant="rectangular"
                          width={64}
                          height={60}
                          animation="wave"
                          sx={{ flexShrink: 0 }}
                        />
                        <Skeleton variant="text" animation="wave" sx={{ flex: 1 }} />
                        <Skeleton
                          variant="rectangular"
                          width={32}
                          height={32}
                          animation="wave"
                          sx={{ flexShrink: 0 }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {row.type === 'end-message' && (
                  <div className={styles.noMoreSuggestions}>
                    <Typography variant="body2" color="text.disabled">
                      That's all for now
                    </Typography>
                  </div>
                )}
              </div>
            );
          })}
        </div>

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
              <Typography
                variant="body2"
                component="span"
                fontWeight={600}
                sx={{ fontSize: themeTokens.typography.fontSize.base }}
              >
                Sign in to record ticks
              </Typography>
              <Typography variant="body1" component="p" color="text.secondary">
                Create a Boardsesh account to log your climbs and track your progress.
              </Typography>
              <Button
                variant="contained"
                startIcon={<LoginOutlined />}
                onClick={() =>
                  openAuthModal({
                    title: 'Sign in to record ticks',
                    description: 'Create an account to log your climbs and track your progress.',
                  })
                }
                fullWidth
              >
                Sign In
              </Button>
            </Stack>
          </SwipeableDrawer>
        )}

        {/* Shared actions drawer — only mount when a climb's actions are open */}
        {actionsClimb && (
          <SwipeableDrawer
            title={
              <div data-swipe-blocked="" {...actionsDragHandlers} className={drawerCss.dragHeaderWrapper}>
                <DrawerClimbHeader climb={actionsClimb} boardDetails={boardDetails} />
              </div>
            }
            placement="bottom"
            height="60%"
            paperRef={actionsPaperRef}
            open
            onClose={handleCloseActions}
            swipeEnabled={false}
            styles={actionsDrawerStyles}
          >
            <ClimbActions
              climb={actionsClimb}
              boardDetails={boardDetails}
              angle={actionsClimb.angle}
              currentPathname={pathname}
              viewMode="list"
              exclude={excludeActions}
              onOpenPlaylistSelector={handleOpenPlaylistFromActions}
              onActionComplete={handleCloseActions}
              onGoToQueue={handleGoToQueue}
            />
          </SwipeableDrawer>
        )}

        {/* Shared playlist selector drawer — only mount when a climb's playlist is open */}
        {playlistClimb && (
          <SwipeableDrawer
            title={<DrawerClimbHeader climb={playlistClimb} boardDetails={boardDetails} />}
            placement="bottom"
            open
            onClose={handleClosePlaylist}
            styles={playlistDrawerStyles}
          >
            <PlaylistSelectionContent
              climbUuid={playlistClimb.uuid}
              boardDetails={boardDetails}
              angle={playlistClimb.angle}
              onDone={handleClosePlaylist}
            />
          </SwipeableDrawer>
        )}
      </>
    );
  },
);

// Static drawer styles — hoisted to avoid per-render allocation
const actionsDrawerStyles = {
  wrapper: {
    width: '100%',
    touchAction: 'pan-y' as const,
    transition: themeTokens.transitions.drawerHeight,
  },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
} as const;

const playlistDrawerStyles = {
  wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
  body: { padding: 0 },
  header: {
    paddingLeft: `${themeTokens.spacing[3]}px`,
    paddingRight: `${themeTokens.spacing[3]}px`,
  },
} as const;

QueueList.displayName = 'QueueList';

export default React.memo(QueueList);
