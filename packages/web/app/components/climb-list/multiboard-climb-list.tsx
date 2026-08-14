'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { useBoardDetailsMap } from '@/app/hooks/use-board-details-map';
import BoardFilterStrip from '@/app/components/board-scroll/board-filter-strip';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import type { SessionBoardConfig } from '@/app/lib/board-config-for-playlist';
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

  // `unsupportedClimbs` / `upsizedClimbs` are intentionally not destructured:
  // the static rows carry no "needs a bigger board" affordance. The hook call
  // stays because it also produces `boardDetailsByClimb`.
  const { boardDetailsByClimb, defaultBoardDetails } = useBoardDetailsMap(
    climbs,
    myBoards,
    selectedBoard,
    sessionBoard,
    fallbackBoardTypes,
  );

  const handleSortChange = (_: React.MouseEvent<HTMLElement>, value: SortBy | null) => {
    if (value && onSortChange) {
      onSortChange(value);
    }
  };

  // Sort toggle and count, rendered above the rows
  const sortControls = showSortToggle ? (
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
      <StaticClimbList
        climbs={climbs}
        boardDetails={defaultBoardDetails}
        boardDetailsByClimb={boardDetailsByClimb}
        isFetching={isFetching}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        header={
          <>
            {header}
            {sortControls}
          </>
        }
        hideEndMessage={hideEndMessage}
        showBottomSpacer={showBottomSpacer}
      />
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
