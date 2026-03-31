'use client';
import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { track } from '@vercel/analytics';
import { Climb, BoardDetails } from '@/app/lib/types';
import ClimbCard from '../climb-card/climb-card';
import ClimbListItem from '../climb-card/climb-list-item';
import { ClimbCardSkeleton, ClimbListItemSkeleton } from './board-page-skeleton';
import { themeTokens } from '@/app/theme/theme-config';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';
import { trackListBatchRender } from '@/app/lib/rendering-metrics';

type ViewMode = 'grid' | 'list';

const VIEW_MODE_PREFERENCE_KEY = 'climbListViewMode';

// Estimated height of a ClimbListItem row (px). Used by the virtualizer
// for initial layout; measured heights replace it after mount.
const ESTIMATED_LIST_ITEM_HEIGHT = 76;

export type ClimbsListProps = {
  boardDetails: BoardDetails;
  boardDetailsMap?: Record<string, BoardDetails>;
  unsupportedClimbs?: Set<string>;
  climbs: Climb[];
  selectedClimbUuid?: string | null;
  isFetching: boolean;
  hasMore: boolean;
  onClimbSelect?: (climb: Climb) => void;
  onLoadMore: () => void;
  header?: React.ReactNode;
  headerInline?: React.ReactNode;
  hideEndMessage?: boolean;
  renderItemExtra?: (climb: Climb) => React.ReactNode;
  showBottomSpacer?: boolean;
};

const ClimbsListSkeleton = ({ aspectRatio, viewMode }: { aspectRatio: number; viewMode: ViewMode }) => {
  if (viewMode === 'list') {
    return Array.from({ length: 10 }, (_, i) => (
      <ClimbListItemSkeleton key={i} />
    ));
  }
  return Array.from({ length: 10 }, (_, i) => (
    <Box key={i} sx={{ width: { xs: '100%', lg: '50%' } }}>
      <ClimbCardSkeleton aspectRatio={aspectRatio} />
    </Box>
  ));
};

const ClimbsList = ({
  boardDetails,
  boardDetailsMap,
  unsupportedClimbs,
  climbs,
  selectedClimbUuid,
  isFetching,
  hasMore,
  onClimbSelect,
  onLoadMore,
  header,
  headerInline,
  hideEndMessage,
  renderItemExtra,
  showBottomSpacer,
}: ClimbsListProps) => {
  const isRustRendererEnabled = useFeatureFlag('rust-svg-rendering');

  // Progressive rendering for grid mode only (list mode uses the virtualizer).
  // Show first batch immediately, rest after a frame. Only batch when the list
  // is replaced (new search), not when items are appended (infinite scroll)
  // — otherwise the height shrinks and the page jumps.
  const INITIAL_BATCH = 6;
  const [visibleCount, setVisibleCount] = useState(climbs.length);
  const prevClimbsRef = useRef(climbs);

  // --- Batch render timing ---
  // Records when a new batch of climbs arrives (data change) so we can measure
  // render duration in useEffect (fires after DOM commit).
  const batchStartRef = useRef<{ time: number; prevLength: number; isInitial: boolean } | null>(
    climbs.length > 0 ? { time: performance.now(), prevLength: 0, isInitial: true } : null,
  );

  if (climbs !== prevClimbsRef.current) {
    const prevClimbs = prevClimbsRef.current;
    prevClimbsRef.current = climbs;

    // Detect append (infinite scroll): new list starts with all previous items
    const isAppend = climbs.length > prevClimbs.length &&
      prevClimbs.length > 0 &&
      climbs[0]?.uuid === prevClimbs[0]?.uuid;

    // Record batch start for any data change that adds items
    if (climbs.length > prevClimbs.length) {
      batchStartRef.current = { time: performance.now(), prevLength: prevClimbs.length, isInitial: prevClimbs.length === 0 };
    }

    if (isAppend) {
      // Show all items immediately — no batching for appended pages
      setVisibleCount(climbs.length);
    } else if (climbs.length > INITIAL_BATCH) {
      setVisibleCount(INITIAL_BATCH);
    }
  }

  useEffect(() => {
    if (visibleCount < climbs.length) {
      const id = requestAnimationFrame(() => setVisibleCount(climbs.length));
      return () => cancelAnimationFrame(id);
    }
  }, [visibleCount, climbs.length]);

  const visibleClimbs = useMemo(
    () => climbs.slice(0, visibleCount),
    [climbs, visibleCount],
  );

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const useVirtualization = viewMode === 'list' && !isRustRendererEnabled;

  // Track batch render timing after DOM commit
  useEffect(() => {
    const batch = batchStartRef.current;
    if (!batch || climbs.length === 0) return;
    // Only fire once per batch (when all items are visible)
    if (visibleCount < climbs.length) return;
    batchStartRef.current = null;
    trackListBatchRender(performance.now() - batch.time, {
      viewMode,
      renderer: isRustRendererEnabled ? 'rust-wasm' : 'svg',
      batchSize: climbs.length - batch.prevLength,
      totalItems: climbs.length,
      isInitial: batch.isInitial,
    });
  }, [climbs.length, visibleCount, viewMode, isRustRendererEnabled]);

  const onClimbSelectRef = useRef(onClimbSelect);
  onClimbSelectRef.current = onClimbSelect;

  useEffect(() => {
    getPreference<ViewMode>(VIEW_MODE_PREFERENCE_KEY)
      .then((stored) => {
        if (stored === 'grid' || stored === 'list') {
          setViewMode(stored);
        }
      })
      .catch(() => {});
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    setPreference(VIEW_MODE_PREFERENCE_KEY, mode).catch(() => {});
    track('View Mode Changed', { mode });
  }, []);

  const handleLoadMore = useCallback(() => {
    track('Infinite Scroll Load More', {
      currentCount: climbs.length,
      hasMore,
    });
    onLoadMore();
  }, [climbs.length, hasMore, onLoadMore]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: handleLoadMore,
    hasMore,
    isFetching,
  });

  const handleClimbClick = useCallback(
    (climb: Climb) => {
      onClimbSelectRef.current?.(climb);
      track('Climb List Item Clicked', { climbUuid: climb.uuid });
    },
    [],
  );

  const climbHandlersMap = useMemo(() => {
    const map = new Map<string, () => void>();
    climbs.forEach(climb => {
      map.set(climb.uuid, () => handleClimbClick(climb));
    });
    return map;
  }, [climbs, handleClimbClick]);

  const resolveBoardDetails = useCallback(
    (climb: Climb): BoardDetails => {
      if (boardDetailsMap && climb.boardType && climb.layoutId != null) {
        const key = `${climb.boardType}:${climb.layoutId}`;
        return boardDetailsMap[key] || boardDetails;
      }
      return boardDetails;
    },
    [boardDetails, boardDetailsMap],
  );

  // --- Window virtualizer for list mode (disabled when Rust renderer is active) ---
  const virtualizer = useWindowVirtualizer({
    count: useVirtualization ? climbs.length : 0,
    estimateSize: () => ESTIMATED_LIST_ITEM_HEIGHT,
    overscan: 15,
    getItemKey: (index) => climbs[index].uuid,
  });

  // Trigger load-more when the last virtual item is rendered
  const virtualItems = virtualizer.getVirtualItems();
  const lastItem = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (lastItem && lastItem.index >= climbs.length - 3 && hasMore && !isFetching) {
      handleLoadMore();
    }
  }, [lastItem?.index, climbs.length, hasMore, isFetching, handleLoadMore]);

  // Memoize sx prop objects
  const headerBoxSx = useMemo(() => ({
    display: 'flex',
    alignItems: 'center',
    position: 'relative' as const,
    padding: `0px 60px ${themeTokens.spacing[1]}px ${themeTokens.spacing[1]}px`,
    minWidth: 0,
  }), []);

  const viewModeToggleBoxSx = useMemo(() => ({
    position: 'absolute' as const,
    right: `${themeTokens.spacing[1]}px`,
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    gap: '2px',
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: `${themeTokens.borderRadius.sm}px`,
    padding: '2px',
  }), []);

  const iconButtonSx = useMemo(() => ({ padding: '4px' }), []);

  const gridContainerSx = useMemo(() => ({
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: `${themeTokens.spacing[4]}px`,
  }), []);

  const cardBoxSx = useMemo(() => ({
    width: { xs: '100%', lg: `calc(50% - ${themeTokens.spacing[4] / 2}px)` },
  }), []);

  const sentinelBoxSx = useMemo(() => ({
    minHeight: `${themeTokens.spacing[5]}px`,
    mt: viewMode === 'grid' ? `${themeTokens.spacing[4]}px` : 0,
  }), [viewMode]);

  const noMoreClimbsBoxSx = useMemo(() => ({
    textAlign: 'center' as const,
    padding: `${themeTokens.spacing[5]}px`,
    color: 'var(--neutral-400)',
  }), []);

  return (
    <Box>
      {header}
      <Box sx={headerBoxSx}>
        {headerInline}
        <Box sx={viewModeToggleBoxSx}>
          <IconButton
            onClick={() => handleViewModeChange('list')}
            aria-label="List view"
            color={viewMode === 'list' ? 'primary' : 'default'}
            size="small"
            sx={iconButtonSx}
          >
            <FormatListBulletedOutlined fontSize="small" />
          </IconButton>
          <IconButton
            onClick={() => handleViewModeChange('grid')}
            aria-label="Grid view"
            color={viewMode === 'grid' ? 'primary' : 'default'}
            size="small"
            sx={iconButtonSx}
          >
            <AppsOutlined fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      {viewMode === 'grid' ? (
        /* Grid (card) mode — not virtualized */
        <Box sx={gridContainerSx}>
          {visibleClimbs.map((climb, index) => (
            <Box key={climb.uuid} sx={cardBoxSx}>
              <div
                {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}
              >
                <ClimbCard
                  climb={climb}
                  boardDetails={resolveBoardDetails(climb)}
                  selected={selectedClimbUuid === climb.uuid}
                  onCoverDoubleClick={climbHandlersMap.get(climb.uuid)}
                  unsupported={unsupportedClimbs?.has(climb.uuid)}
                />
              </div>
              {renderItemExtra?.(climb)}
            </Box>
          ))}
          {isFetching && (!climbs || climbs.length === 0) ? (
            <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="grid" />
          ) : null}
        </Box>
      ) : useVirtualization ? (
        /* List mode — virtualized with window scroll */
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {isFetching && climbs.length === 0 ? (
            <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="list" />
          ) : (
            virtualItems.map((virtualRow) => {
              const climb = climbs[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div {...(virtualRow.index === 0 ? { id: 'onboarding-climb-card' } : {})}>
                    <ClimbListItem
                      climb={climb}
                      boardDetails={resolveBoardDetails(climb)}
                      selected={selectedClimbUuid === climb.uuid}
                      onSelect={climbHandlersMap.get(climb.uuid)}
                      onThumbnailClick={climbHandlersMap.get(climb.uuid)}
                      disableThumbnailNavigation
                      unsupported={unsupportedClimbs?.has(climb.uuid)}
                    />
                  </div>
                  {renderItemExtra?.(climb)}
                </div>
              );
            })
          )}
        </div>
      ) : (
        /* List mode — non-virtualized (Rust renderer: items are cheap <img> tags) */
        <div>
          {isFetching && climbs.length === 0 ? (
            <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="list" />
          ) : (
            visibleClimbs.map((climb, index) => (
              <div key={climb.uuid}>
                <div {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}>
                  <ClimbListItem
                    climb={climb}
                    boardDetails={resolveBoardDetails(climb)}
                    selected={selectedClimbUuid === climb.uuid}
                    onSelect={climbHandlersMap.get(climb.uuid)}
                    onThumbnailClick={climbHandlersMap.get(climb.uuid)}
                    disableThumbnailNavigation
                    unsupported={unsupportedClimbs?.has(climb.uuid)}
                  />
                </div>
                {renderItemExtra?.(climb)}
              </div>
            ))
          )}
        </div>
      )}

      {/* Sentinel for infinite scroll (grid mode fallback) */}
      <Box ref={sentinelRef} sx={sentinelBoxSx}>
        {isFetching && climbs.length > 0 && (
          viewMode === 'grid' ? (
            <Box sx={gridContainerSx}>
              <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="grid" />
            </Box>
          ) : (
            <ClimbsListSkeleton aspectRatio={boardDetails.boardWidth / boardDetails.boardHeight} viewMode="list" />
          )
        )}
        {!hasMore && climbs.length > 0 && !hideEndMessage && (
          <Box sx={noMoreClimbsBoxSx}>
            No more climbs
          </Box>
        )}
      </Box>

      {showBottomSpacer && (
        <Box sx={{ height: themeTokens.layout.bottomNavSpacer }} aria-hidden />
      )}
    </Box>
  );
};

export default ClimbsList;
