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
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import type { SessionBoardConfig } from '@/app/lib/board-config-for-playlist';
import { themeTokens } from '@/app/theme/theme-config';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { Climb } from '@/app/lib/types';

export type SortBy = 'popular' | 'new';

type MultiboardClimbListProps = {
  climbs: Climb[];
  isFetching: boolean;
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  selectedBoard: UserBoard | null;
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
  /** SSR-fetched user boards, forwarded to useMyBoards so board art resolves without a flash. */
  initialBoards?: UserBoard[] | null;
  /**
   * Pre-fetched boards to use instead of the internal `useMyBoards` call.
   * When provided, skips the internal GraphQL request entirely — used by
   * callers that already hold the list (e.g. playlist detail view).
   */
  boards?: UserBoard[];
};

export default function MultiboardClimbList({
  climbs,
  isFetching,
  isLoading,
  hasMore,
  onLoadMore,
  selectedBoard,
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
}: MultiboardClimbListProps) {
  const { t } = useTranslation('climbs');
  // Only fetch boards internally when the caller hasn't supplied them.
  // Passing `enabled={false}` short-circuits useMyBoards so we don't fire a
  // duplicate GraphQL request against the same endpoint.
  const { boards: fetchedBoards } = useMyBoards(externalBoards === undefined, 50, initialBoards);
  const myBoards = externalBoards ?? fetchedBoards;

  // www no longer knows which board you're physically on — party sessions live
  // in the app — so board details resolve from the list's selected board alone.
  const sessionBoard: SessionBoardConfig | null = null;

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

  // Sort toggle and count, rendered above the rows. Carries its own padding and
  // 40px floor: it used to be handed to ClimbsList as `headerInline`, which sat
  // it inside a padded header container. In the static list it is the header, so
  // without this it would sit flush at x=0 above rows inset by 8px.
  const sortControls = showSortToggle ? (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        flexWrap: 'wrap',
        padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
        minHeight: 40,
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

  return <Box>{climbListContent}</Box>;
}
