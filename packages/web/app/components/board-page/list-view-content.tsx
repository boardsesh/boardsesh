'use client';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import { usePathname } from 'next/navigation';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import ClimbListItem from '../climb-card/climb-list-item';
import { ClimbListItemSkeleton } from './board-page-skeleton';
import { themeTokens } from '@/app/theme/theme-config';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import SwipeHintOrchestrator from './swipe-hint-orchestrator';
import type { ViewContentRenderProps } from './climbs-list-shared';

const ListViewContent = ({
  visibleClimbs,
  boardDetails,
  resolveBoardDetails,
  initialImageCount,
  unsupportedClimbs,
  upsizedClimbs,
  isFetching,
  hasMore,
  climbs,
  handleClimbClickByIndex,
  handleClimbThumbnailClickByIndex,
  handleNeedsBiggerBoard,
  handleOpenActions,
  handleOpenPlaylistSelector,
  addToQueue,
  handleLoadMore,
  renderItemExtra,
}: ViewContentRenderProps) => {
  const pathname = usePathname();
  const isDark = useIsDarkMode();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // --- List virtualization ---
  // Only ~40-50 items are mounted at a time instead of 600+.
  // Overscan of 25 items (1800px) provides enough headroom so that fast scrolling
  // never outpaces the render cycle and causes a blank screen.
  const virtualizer = useWindowVirtualizer({
    count: visibleClimbs.length,
    estimateSize: () => 107,
    overscan: 25,
    getItemKey: (index) => visibleClimbs[index]?.uuid ?? index,
    // Provide a fake viewport so the virtualizer renders items during SSR.
    // Without this, getVirtualItems() returns [] on the server and the
    // climb list is entirely client-rendered (hurts LCP).
    initialRect: { width: 375, height: 812 },
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Virtualizer-based infinite scroll for list mode
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (!lastVirtualItem) return;
    if (lastVirtualItem.index >= visibleClimbs.length - 5 && hasMore && !isFetching) {
      handleLoadMore();
    }
  }, [lastVirtualItem?.index, visibleClimbs.length, hasMore, isFetching, handleLoadMore]);

  // Loading skeleton for list fetching
  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: handleLoadMore,
    hasMore,
    isFetching,
  });

  const loadingSkeletonSx = useMemo(
    () => ({
      minHeight: `${themeTokens.spacing[5]}px`,
    }),
    [],
  );

  const onSelectHandlers = useMemo(() => {
    return visibleClimbs.map((_: unknown, index: number) =>
      () => handleClimbClickByIndex(index),
    );
  }, [visibleClimbs, handleClimbClickByIndex]);

  const onThumbnailClickHandlers = useMemo(() => {
    return visibleClimbs.map((_: unknown, index: number) =>
      () => handleClimbThumbnailClickByIndex(index),
    );
  }, [visibleClimbs, handleClimbThumbnailClickByIndex]);

  return (
    <div translate="no">
      {isFetching && climbs.length === 0 ? (
        Array.from({ length: 10 }, (_, i) => <ClimbListItemSkeleton key={i} />)
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative', backgroundColor: 'inherit' }}>
          {virtualItems.map((virtualItem) => {
            const climb = visibleClimbs[virtualItem.index];
            const index = virtualItem.index;
            if (!climb) return null;
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                  contain: 'layout style paint',
                }}
              >
                <ClimbListItem
                  climb={climb}
                  boardDetails={resolveBoardDetails(climb)}
                  pathname={pathname}
                  isDark={isDark}
                  preferImageLayers={index < initialImageCount}
                  fetchPriority={index === 0 ? 'high' : undefined}
                  onSelect={onSelectHandlers[index]}
                  onThumbnailClick={onThumbnailClickHandlers[index]}
                  disableSwipe={!hydrated}
                  unsupported={unsupportedClimbs?.has(climb.uuid)}
                  needsBiggerBoard={upsizedClimbs?.has(climb.uuid)}
                  onNeedsBiggerBoard={handleNeedsBiggerBoard}
                  onOpenActions={handleOpenActions}
                  onOpenPlaylistSelector={handleOpenPlaylistSelector}
                  addToQueue={addToQueue}
                />
                {renderItemExtra?.(climb)}
              </div>
            );
          })}
        </div>
      )}
      {climbs.length > 0 && <SwipeHintOrchestrator />}
      {/* Loading skeleton for infinite scroll */}
      <Box ref={sentinelRef} sx={loadingSkeletonSx}>
        {isFetching && climbs.length > 0 && (
          Array.from({ length: 3 }, (_, i) => <ClimbListItemSkeleton key={i} />)
        )}
      </Box>
    </div>
  );
};

export default ListViewContent;
