'use client';

import React, { useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { useBoardDetailsMap } from '@/app/hooks/use-board-details-map';
import { useClimbActionsData } from '@/app/hooks/use-climb-actions-data';
import BoardFilterStrip from '@/app/components/board-scroll/board-filter-strip';
import ClimbsList from '@/app/components/board-page/climbs-list';
import { FavoritesProvider } from '@/app/components/climb-actions/favorites-batch-context';
import { PlaylistsProvider } from '@/app/components/climb-actions/playlists-batch-context';
import { getDefaultAngleForBoard, type SessionBoardConfig } from '@/app/lib/board-config-for-playlist';
import { useOptionalQueueActions } from '@/app/components/graphql-queue';
import { usePersistentSessionState } from '@/app/components/persistent-session/persistent-session-context';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { Climb } from '@/app/lib/types';

export type SortBy = 'popular' | 'new';

type MultiboardClimbListProps = {
  climbs: Climb[];
  isFetching: boolean;
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  // Board filter
  showBoardFilter?: boolean;
  /** Board types present in the climbs (used for disabling filter cards) */
  boardTypes?: string[];
  selectedBoard: UserBoard | null;
  onBoardSelect: (board: UserBoard | null) => void;
  // Sort toggle
  showSortToggle?: boolean;
  sortBy?: SortBy;
  onSortChange?: (sortBy: SortBy) => void;
  totalCount?: number;
  // Climb interaction
  onClimbSelect?: (climb: Climb) => void;
  selectedClimbUuid?: string | null;
  // Optional header content
  header?: React.ReactNode;
  hideEndMessage?: boolean;
  showBottomSpacer?: boolean;
  /** Fallback board types for default board details resolution */
  fallbackBoardTypes?: string[];
  /** SSR-fetched user boards, forwarded to useMyBoards so the filter strip renders without a flash. */
  initialBoards?: UserBoard[] | null;
  /**
   * Pre-fetched boards to use instead of the internal `useMyBoards` call.
   * When provided, skips the internal GraphQL request entirely — used by
   * callers that already hold the list (e.g. playlist detail view).
   */
  boards?: UserBoard[];
  /** Loading flag matching `boards` when it's passed in externally. */
  boardsLoading?: boolean;
};

export default function MultiboardClimbList({
  climbs,
  isFetching,
  isLoading,
  hasMore,
  onLoadMore,
  showBoardFilter = true,
  boardTypes,
  selectedBoard,
  onBoardSelect,
  showSortToggle = false,
  sortBy = 'popular',
  onSortChange,
  totalCount,
  onClimbSelect,
  selectedClimbUuid,
  header,
  hideEndMessage = true,
  showBottomSpacer = true,
  fallbackBoardTypes,
  initialBoards,
  boards: externalBoards,
  boardsLoading: externalBoardsLoading,
}: MultiboardClimbListProps) {
  const { t } = useTranslation('climbs');
  // Only fetch boards internally when the caller hasn't supplied them.
  // Passing `enabled={false}` short-circuits useMyBoards so we don't fire a
  // duplicate GraphQL request against the same endpoint.
  const { boards: fetchedBoards, isLoading: fetchedBoardsLoading } = useMyBoards(
    externalBoards === undefined,
    50,
    initialBoards,
  );
  const myBoards = externalBoards ?? fetchedBoards;
  const isLoadingBoards = externalBoards !== undefined ? (externalBoardsLoading ?? false) : fetchedBoardsLoading;

  // Prefer the user's active session (the board they are actually climbing on)
  // so playlist previews match the physical wall. Falls back to the list's
  // selected board when there is no session.
  const { activeSession } = usePersistentSessionState();
  const sessionBoard: SessionBoardConfig | null = useMemo(() => {
    if (!activeSession?.parsedParams) return null;
    const { board_name, layout_id, size_id, set_ids } = activeSession.parsedParams;
    return {
      boardType: board_name,
      layoutId: layout_id,
      sizeId: size_id,
      setIds: set_ids,
    };
  }, [activeSession]);

  const { boardDetailsByClimb, defaultBoardDetails, unsupportedClimbs, upsizedClimbs } = useBoardDetailsMap(
    climbs,
    myBoards,
    selectedBoard,
    sessionBoard,
    fallbackBoardTypes,
  );

  // Climb action data for favorites/playlists context
  const climbUuids = useMemo(() => climbs.map((c) => c.uuid), [climbs]);
  const actionsBoardName = selectedBoard?.boardType || (climbs[0]?.boardType ?? 'kilter');
  const actionsLayoutId = selectedBoard?.layoutId || (climbs[0]?.layoutId ?? 1);
  const actionsAngle = selectedBoard?.angle || getDefaultAngleForBoard(actionsBoardName);

  const { favoritesProviderProps, playlistsProviderProps } = useClimbActionsData({
    boardName: actionsBoardName,
    layoutId: actionsLayoutId,
    angle: actionsAngle,
    climbUuids,
  });
  const queueActions = useOptionalQueueActions();

  // Fallback for the rare case with no queue bridge (e.g. mid-hydration): navigate
  // to the climb's view page so the user is never stranded.
  const navigateToClimb = useCallback(
    async (climb: Climb) => {
      // Capture the current path before the async fetch so back-button returnUrl is correct.
      const returnUrl = typeof window !== 'undefined' ? window.location.pathname : null;
      try {
        const bt = climb.boardType || selectedBoard?.boardType;
        if (!bt) return;
        const params = new URLSearchParams({ boardType: bt, climbUuid: climb.uuid });
        const res = await fetch(`/api/internal/climb-redirect?${params}`);
        if (!res.ok) return;
        const { url } = (await res.json()) as { url?: string };
        if (url) {
          const sep = url.includes('?') ? '&' : '?';
          window.location.href = returnUrl ? `${url}${sep}returnUrl=${encodeURIComponent(returnUrl)}` : url;
        }
      } catch (error) {
        console.error('Failed to navigate to climb:', error);
      }
    },
    [selectedBoard],
  );

  // Internal selection state drives the visual highlight. A caller-supplied
  // selectedClimbUuid takes precedence so controlled usage still works.
  const [internalSelectedUuid, setInternalSelectedUuid] = useState<string | null>(null);
  const effectiveSelectedUuid = selectedClimbUuid ?? internalSelectedUuid;

  // Row click: activate the climb (visual highlight + set as queue's current climb).
  // Thumbnail click reuses this via ClimbsList and additionally dispatches the
  // PLAY_DRAWER_EVENT so the play view drawer opens. Mirrors the pattern in
  // liked-climbs-list.tsx and board-page-climbs-list.tsx.
  const handleClimbSelect = useCallback(
    (climb: Climb) => {
      setInternalSelectedUuid(climb.uuid);
      if (queueActions?.setCurrentClimb) {
        void queueActions.setCurrentClimb(climb);
      } else {
        void navigateToClimb(climb);
      }
      onClimbSelect?.(climb);
    },
    [queueActions, navigateToClimb, onClimbSelect],
  );

  const handleSortChange = (_: React.MouseEvent<HTMLElement>, value: SortBy | null) => {
    if (value && onSortChange) {
      onSortChange(value);
    }
  };

  // Header with sort toggle and count
  const headerInline = showSortToggle ? (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        flexWrap: 'wrap',
        flex: 1,
        minWidth: 0,
      }}
    >
      <ToggleButtonGroup exclusive size="small" value={sortBy} onChange={handleSortChange}>
        <ToggleButton value="popular">{t('multiboardList.popular')}</ToggleButton>
        <ToggleButton value="new">{t('multiboardList.new')}</ToggleButton>
      </ToggleButtonGroup>
      {totalCount != null && totalCount > 0 && (
        <Typography variant="body2" color="text.secondary">
          {t('multiboardList.count', { count: totalCount })}
        </Typography>
      )}
    </Box>
  ) : undefined;

  let climbListContent: React.ReactNode;
  if (isLoading && climbs.length === 0) {
    climbListContent = (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  } else if (climbs.length === 0 && !isLoading) {
    climbListContent = (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          {t('multiboardList.noClimbsFound')}
        </Typography>
      </Box>
    );
  } else if (defaultBoardDetails) {
    climbListContent = (
      <FavoritesProvider {...favoritesProviderProps}>
        <PlaylistsProvider {...playlistsProviderProps}>
          <ClimbsList
            boardDetails={defaultBoardDetails}
            boardDetailsByClimb={boardDetailsByClimb}
            unsupportedClimbs={unsupportedClimbs}
            upsizedClimbs={upsizedClimbs}
            climbs={climbs}
            selectedClimbUuid={effectiveSelectedUuid}
            isFetching={isFetching}
            hasMore={hasMore}
            onClimbSelect={handleClimbSelect}
            onLoadMore={onLoadMore}
            addToQueue={queueActions?.addToQueue}
            header={header}
            headerInline={headerInline}
            hideEndMessage={hideEndMessage}
            showBottomSpacer={showBottomSpacer}
          />
        </PlaylistsProvider>
      </FavoritesProvider>
    );
  } else {
    climbListContent = null;
  }

  return (
    <Box>
      {/* Board filter - thumbnail scroll cards */}
      {showBoardFilter && (
        <BoardFilterStrip
          boards={myBoards}
          loading={isLoadingBoards}
          selectedBoard={selectedBoard}
          onBoardSelect={onBoardSelect}
          boardTypes={boardTypes}
          disabledText="No climbs"
        />
      )}

      {climbListContent}
    </Box>
  );
}
