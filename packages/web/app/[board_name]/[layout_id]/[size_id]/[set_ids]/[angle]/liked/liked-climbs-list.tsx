'use client';

import React, { useEffect, useCallback, useState, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import { FormatListBulletedOutlined, AppsOutlined } from '@mui/icons-material';
import { useInfiniteQuery } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { track } from '@vercel/analytics';
import { Climb, BoardDetails } from '@/app/lib/types';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  GET_USER_FAVORITE_CLIMBS,
  GetUserFavoriteClimbsQueryResponse,
  GetUserFavoriteClimbsQueryVariables,
} from '@/app/lib/graphql/operations/favorites';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useQueueActions } from '@/app/components/graphql-queue';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import ClimbCard from '@/app/components/climb-card/climb-card';
import ClimbListItem from '@/app/components/climb-card/climb-list-item';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import DrawerClimbHeader from '@/app/components/climb-card/drawer-climb-header';
import { ClimbActions } from '@/app/components/climb-actions';
import PlaylistSelectionContent from '@/app/components/climb-actions/playlist-selection-content';
import { ClimbCardSkeleton } from '@/app/components/board-page/board-page-skeleton';
import { EmptyState } from '@/app/components/ui/empty-state';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { SelectionStoreContext, useSelectionStore } from '@/app/components/board-page/selected-climb-store';
import styles from '@/app/components/library/playlist-view.module.css';
import listStyles from '@/app/components/board-page/climbs-list.module.css';

type ViewMode = 'grid' | 'list';

// Static drawer style objects (hoisted to avoid per-render allocation)
const sharedDrawerStyles = {
  wrapper: { height: 'auto', width: '100%' },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
} as const;

const sharedPlaylistDrawerStyles = {
  wrapper: { height: 'auto', maxHeight: '70vh', width: '100%' },
  body: { padding: 0 },
  header: { paddingLeft: `${themeTokens.spacing[3]}px`, paddingRight: `${themeTokens.spacing[3]}px` },
} as const;

// --- Shared drawers extracted to isolate state from list re-renders ---
type LikedDrawerHandle = {
  openActions: (climb: Climb) => void;
  openPlaylistSelector: (climb: Climb) => void;
};

type LikedDrawersProps = {
  boardDetails: BoardDetails;
};

const LikedDrawers = forwardRef<LikedDrawerHandle, LikedDrawersProps>(
  ({ boardDetails }, ref) => {
    const pathname = usePathname();
    const [activeDrawerClimb, setActiveDrawerClimb] = useState<Climb | null>(null);
    const [drawerMode, setDrawerMode] = useState<'actions' | 'playlist' | null>(null);

    useImperativeHandle(ref, () => ({
      openActions: (climb: Climb) => {
        setActiveDrawerClimb(climb);
        setDrawerMode('actions');
      },
      openPlaylistSelector: (climb: Climb) => {
        setActiveDrawerClimb(climb);
        setDrawerMode('playlist');
      },
    }), []);

    const handleCloseDrawer = useCallback(() => setDrawerMode(null), []);
    const handleSwitchToPlaylist = useCallback(() => setDrawerMode('playlist'), []);
    const handleDrawerTransitionEnd = useCallback((open: boolean) => {
      if (!open) setActiveDrawerClimb(null);
    }, []);

    const excludeActions = useMemo(
      () => getExcludedClimbActions(boardDetails.board_name, 'list'),
      [boardDetails.board_name],
    );

    return (
      <>
        <SwipeableDrawer
          title={activeDrawerClimb ? <DrawerClimbHeader climb={activeDrawerClimb} boardDetails={boardDetails} /> : undefined}
          placement="bottom"
          open={drawerMode === 'actions'}
          onClose={handleCloseDrawer}
          onTransitionEnd={handleDrawerTransitionEnd}
          styles={sharedDrawerStyles}
        >
          {activeDrawerClimb && (
            <ClimbActions
              climb={activeDrawerClimb}
              boardDetails={boardDetails}
              angle={activeDrawerClimb.angle}
              currentPathname={pathname}
              viewMode="list"
              exclude={excludeActions}
              onOpenPlaylistSelector={handleSwitchToPlaylist}
              onActionComplete={handleCloseDrawer}
            />
          )}
        </SwipeableDrawer>

        <SwipeableDrawer
          title={activeDrawerClimb ? <DrawerClimbHeader climb={activeDrawerClimb} boardDetails={boardDetails} /> : undefined}
          placement="bottom"
          open={drawerMode === 'playlist'}
          onClose={handleCloseDrawer}
          onTransitionEnd={handleDrawerTransitionEnd}
          styles={sharedPlaylistDrawerStyles}
        >
          {activeDrawerClimb && (
            <PlaylistSelectionContent
              climbUuid={activeDrawerClimb.uuid}
              boardDetails={boardDetails}
              angle={activeDrawerClimb.angle}
              onDone={handleCloseDrawer}
            />
          )}
        </SwipeableDrawer>
      </>
    );
  },
);
LikedDrawers.displayName = 'LikedDrawers';

type LikedClimbsListProps = {
  boardDetails: BoardDetails;
  angle: number;
};

const skeletonCardBoxSx = { width: { xs: '100%', lg: '50%' } };

const ClimbsListSkeleton = ({ aspectRatio }: { aspectRatio: number }) => {
  return (
    <>
      {Array.from({ length: 6 }, (_, i) => (
        <Box sx={skeletonCardBoxSx} key={i}>
          <ClimbCardSkeleton aspectRatio={aspectRatio} />
        </Box>
      ))}
    </>
  );
};

export default function LikedClimbsList({
  boardDetails,
  angle,
}: LikedClimbsListProps) {
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const { setCurrentClimb, addToQueue } = useQueueActions();
  const { showMessage } = useSnackbar();
  const [selectedClimbUuid, setSelectedClimbUuid] = useState<string | null>(null);
  const selectionStore = useSelectionStore(selectedClimbUuid);
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  useEffect(() => {
    getPreference<ViewMode>('likedClimbsViewMode').then((saved) => {
      if (saved) setViewMode(saved);
    });
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    setPreference('likedClimbsViewMode', mode);
    track('Liked Climbs View Mode Changed', { mode });
  }, []);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
    error,
  } = useInfiniteQuery({
    queryKey: ['likedClimbs', boardDetails.board_name, boardDetails.layout_id, boardDetails.size_id, angle],
    queryFn: async ({ pageParam = 0 }) => {
      const response = await executeGraphQL<
        GetUserFavoriteClimbsQueryResponse,
        GetUserFavoriteClimbsQueryVariables
      >(
        GET_USER_FAVORITE_CLIMBS,
        {
          input: {
            boardName: boardDetails.board_name,
            layoutId: boardDetails.layout_id,
            sizeId: boardDetails.size_id,
            setIds: boardDetails.set_ids.join(','),
            angle,
            page: pageParam,
            pageSize: 20,
          },
        },
        token,
      );
      return response.userFavoriteClimbs;
    },
    enabled: !tokenLoading && !!token,
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.length;
    },
    staleTime: 5 * 60 * 1000,
  });

  const allClimbs: Climb[] = data?.pages.flatMap((page) => page.climbs as Climb[]) ?? [];
  const totalCount = data?.pages[0]?.totalCount ?? 0;

  useEffect(() => {
    if (error) {
      console.error('Error loading liked climbs:', error);
      showMessage('Failed to load liked climbs', 'error');
    }
  }, [error, showMessage]);

  // Show all liked climbs regardless of layout (unlike playlists, favorites span all layouts)
  const visibleClimbs: Climb[] = useMemo(() => {
    return allClimbs.map((climb) => ({ ...climb, angle }));
  }, [allClimbs, angle]);

  const handleLoadMore = useCallback(() => {
    track('Liked Climbs Infinite Scroll Load More', {
      currentCount: allClimbs.length,
      hasMore: hasNextPage,
    });
    fetchNextPage();
  }, [allClimbs.length, hasNextPage, fetchNextPage]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: handleLoadMore,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  const handleClimbDoubleClick = useCallback((climb: Climb) => {
    setSelectedClimbUuid(climb.uuid);
    setCurrentClimb(climb);
    track('Liked Climb Card Double Clicked', {
      climbUuid: climb.uuid,
      angle: climb.angle,
    });
  }, [setCurrentClimb]);

  const climbHandlersMap = useMemo(() => {
    const map = new Map<string, () => void>();
    visibleClimbs.forEach(climb => {
      map.set(climb.uuid, () => handleClimbDoubleClick(climb));
    });
    return map;
  }, [visibleClimbs, handleClimbDoubleClick]);

  const sentinelStyle = useMemo(
    () => ({ minHeight: '20px', marginTop: '16px' }),
    [],
  );

  const gridContainerSx = useMemo(() => ({
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '16px',
  }), []);

  const cardBoxSx = useMemo(() => ({
    width: { xs: '100%', lg: '50%' },
  }), []);

  const aspectRatio = boardDetails.boardWidth / boardDetails.boardHeight;

  // --- Shared drawers via imperative handle (state lives in LikedDrawers, not here) ---
  const drawerRef = useRef<LikedDrawerHandle>(null);

  const handleOpenActions = useCallback((climb: Climb) => {
    if (process.env.NODE_ENV !== 'production' && !drawerRef.current) {
      console.warn('LikedDrawers ref not attached — openActions is a no-op');
    }
    drawerRef.current?.openActions(climb);
  }, []);

  const handleOpenPlaylistSelector = useCallback((climb: Climb) => {
    if (process.env.NODE_ENV !== 'production' && !drawerRef.current) {
      console.warn('LikedDrawers ref not attached — openPlaylistSelector is a no-op');
    }
    drawerRef.current?.openPlaylistSelector(climb);
  }, []);

  if ((isLoading || tokenLoading) && allClimbs.length === 0) {
    return (
      <div className={styles.climbsSection}>
        <Box sx={gridContainerSx}>
          <ClimbsListSkeleton aspectRatio={aspectRatio} />
        </Box>
      </div>
    );
  }

  if (error && allClimbs.length === 0) {
    return (
      <div className={styles.climbsSection}>
        <EmptyState description="Failed to load liked climbs" />
      </div>
    );
  }

  if (visibleClimbs.length === 0 && !isFetching) {
    return (
      <div className={styles.climbsSection}>
        <EmptyState description="No liked climbs yet. Heart some climbs to see them here!" />
      </div>
    );
  }

  return (
    <SelectionStoreContext.Provider value={selectionStore}>
    <div className={styles.climbsSection}>
      {/* View Mode Toggle */}
      <div className={styles.viewModeToggle}>
        <IconButton
          size="small"
          color={viewMode === 'list' ? 'primary' : 'default'}
          onClick={() => handleViewModeChange('list')}
          aria-label="List view"
        >
          <FormatListBulletedOutlined />
        </IconButton>
        <IconButton
          size="small"
          color={viewMode === 'grid' ? 'primary' : 'default'}
          onClick={() => handleViewModeChange('grid')}
          aria-label="Grid view"
        >
          <AppsOutlined />
        </IconButton>
      </div>


      {viewMode === 'grid' ? (
        <Box sx={gridContainerSx}>
          {visibleClimbs.map((climb) => (
            <Box sx={cardBoxSx} key={climb.uuid} className={listStyles.gridItem}>
              <ClimbCard
                climb={climb}
                boardDetails={boardDetails}
                onCoverClick={climbHandlersMap.get(climb.uuid)}
              />
            </Box>
          ))}
          {isFetching && allClimbs.length === 0 && (
            <ClimbsListSkeleton aspectRatio={aspectRatio} />
          )}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          {visibleClimbs.map((climb) => (
            <div key={climb.uuid} className={listStyles.listItem}>
            <ClimbListItem
              climb={climb}
              boardDetails={boardDetails}
              onSelect={climbHandlersMap.get(climb.uuid)}
              onThumbnailClick={climbHandlersMap.get(climb.uuid)}
              disableThumbnailNavigation
              onOpenActions={handleOpenActions}
              onOpenPlaylistSelector={handleOpenPlaylistSelector}
              addToQueue={addToQueue}
            />
            </div>
          ))}
        </Box>
      )}

      {/* Sentinel element for Intersection Observer */}
      <div ref={sentinelRef} style={sentinelStyle}>
        {isFetchingNextPage && (
          <Box sx={gridContainerSx}>
            <ClimbsListSkeleton aspectRatio={aspectRatio} />
          </Box>
        )}
        {!hasNextPage && visibleClimbs.length > 0 && (
          <div className={styles.endOfList}>
            {allClimbs.length >= totalCount ? `All ${visibleClimbs.length} climbs loaded` : 'No more climbs'}
          </div>
        )}
      </div>

      {/* Shared drawers — owns its own state so open/close doesn't re-render the list */}
      <LikedDrawers ref={drawerRef} boardDetails={boardDetails} />
    </div>
    </SelectionStoreContext.Provider>
  );
}
