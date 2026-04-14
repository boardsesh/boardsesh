'use client';
import React, { useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import dynamic from 'next/dynamic';
import { Climb, BoardDetails } from '@/app/lib/types';
import { ClimbCardSkeleton } from './board-page-skeleton';
import { themeTokens } from '@/app/theme/theme-config';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import listStyles from './climbs-list.module.css';
import type { ViewContentRenderProps } from './climbs-list-shared';

const ClimbCard = dynamic(() => import('../climb-card/climb-card'), { ssr: false });

type GridClimbItemProps = {
  climb: Climb;
  index: number;
  boardDetails: BoardDetails;
  preferImageLayers: boolean;
  unsupported?: boolean;
  needsBiggerBoard?: boolean;
  onClimbClickByIndex: (index: number) => void;
  onNeedsBiggerBoard?: () => void;
  renderItemExtra?: (climb: Climb) => React.ReactNode;
};

const GridClimbItem = React.memo(function GridClimbItem({
  climb,
  index,
  boardDetails,
  preferImageLayers,
  unsupported,
  needsBiggerBoard,
  onClimbClickByIndex,
  onNeedsBiggerBoard,
  renderItemExtra,
}: GridClimbItemProps) {
  const handleCoverClick = useCallback(() => {
    if (needsBiggerBoard) {
      onNeedsBiggerBoard?.();
      return;
    }
    onClimbClickByIndex(index);
  }, [onClimbClickByIndex, index, needsBiggerBoard, onNeedsBiggerBoard]);
  return (
    <>
      <div {...(index === 0 ? { id: 'onboarding-climb-card' } : {})}>
        <ClimbCard
          climb={climb}
          boardDetails={boardDetails}
          preferImageLayers={preferImageLayers}
          onCoverClick={handleCoverClick}
          unsupported={unsupported || needsBiggerBoard}
        />
      </div>
      {renderItemExtra?.(climb)}
    </>
  );
});

const GridViewContent = ({
  visibleClimbs,
  boardDetails,
  resolveBoardDetails,
  initialImageCount,
  unsupportedClimbs,
  upsizedClimbs,
  isFetching,
  hasMore,
  climbs,
  handleClimbThumbnailClickByIndex,
  handleNeedsBiggerBoard,
  handleLoadMore,
  renderItemExtra,
}: ViewContentRenderProps) => {
  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: handleLoadMore,
    hasMore,
    isFetching,
  });

  const gridContainerSx = useMemo(
    () => ({
      display: 'flex',
      flexWrap: 'wrap' as const,
      gap: `${themeTokens.spacing[4]}px`,
    }),
    [],
  );

  const cardBoxSx = useMemo(
    () => ({
      width: { xs: '100%', lg: `calc(50% - ${themeTokens.spacing[4] / 2}px)` },
    }),
    [],
  );

  const sentinelBoxSx = useMemo(
    () => ({
      minHeight: `${themeTokens.spacing[5]}px`,
      mt: `${themeTokens.spacing[4]}px`,
    }),
    [],
  );

  const aspectRatio = boardDetails.boardWidth / boardDetails.boardHeight;

  return (
    <>
      {/* Grid (card) mode — not virtualized */}
      <Box sx={gridContainerSx} translate="no">
        {visibleClimbs.map((climb, index) => (
          <Box key={climb.uuid} sx={cardBoxSx} className={listStyles.gridItem}>
            <GridClimbItem
              climb={climb}
              index={index}
              boardDetails={resolveBoardDetails(climb)}
              preferImageLayers={index < initialImageCount}
              unsupported={unsupportedClimbs?.has(climb.uuid)}
              needsBiggerBoard={upsizedClimbs?.has(climb.uuid)}
              onClimbClickByIndex={handleClimbThumbnailClickByIndex}
              onNeedsBiggerBoard={handleNeedsBiggerBoard}
              renderItemExtra={renderItemExtra}
            />
          </Box>
        ))}
        {isFetching && (!climbs || climbs.length === 0) ? (
          Array.from({ length: 10 }, (_, i) => (
            <Box key={i} sx={cardBoxSx}>
              <ClimbCardSkeleton aspectRatio={aspectRatio} />
            </Box>
          ))
        ) : null}
      </Box>

      {/* Sentinel for infinite scroll */}
      <Box ref={sentinelRef} sx={sentinelBoxSx}>
        {isFetching && climbs.length > 0 && (
          <Box sx={gridContainerSx}>
            {Array.from({ length: 4 }, (_, i) => (
              <Box key={i} sx={cardBoxSx}>
                <ClimbCardSkeleton aspectRatio={aspectRatio} />
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </>
  );
};

export default GridViewContent;
