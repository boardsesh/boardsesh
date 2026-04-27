'use client';

import React, { useState, useCallback, useMemo, useRef } from 'react';
import MuiButton from '@mui/material/Button';
import MuiBadge from '@mui/material/Badge';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import SwipeableDrawer from '../../swipeable-drawer/swipeable-drawer';
import { ActionTooltip } from '../action-tooltip';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { useOptionalBoardProvider, BoardProvider } from '../../board-provider/board-provider-context';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { LogAscentForm } from '../../logbook/logascent-form';
import { track } from '@/app/lib/analytics';
import { constructClimbInfoUrl } from '@/app/lib/url-utils';
import { openExternalUrl } from '@/app/lib/open-external-url';
import { themeTokens } from '@/app/theme/theme-config';
import { useAlwaysTickInApp } from '@/app/hooks/use-always-tick-in-app';
import { useSession } from 'next-auth/react';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import BoardScrollSection from '../../board-scroll/board-scroll-section';
import BoardScrollCard from '../../board-scroll/board-scroll-card';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardName, BoardDetails } from '@/app/lib/types';
import { LogAscentDrawer } from '../../logbook/log-ascent-drawer';
import type { LogbookEntry } from '@/app/hooks/use-logbook';

const VALID_BOARD_NAMES: ReadonlySet<string> = new Set<BoardName>(['kilter', 'tension', 'moonboard']);
const EMPTY_LOGBOOK: LogbookEntry[] = [];

function isValidBoardName(value: string): value is BoardName {
  return VALID_BOARD_NAMES.has(value);
}

export function TickAction({
  climb,
  boardDetails,
  angle,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  onComplete,
  onTickAction,
}: ClimbActionProps): ClimbActionResult {
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState<UserBoard | null>(null);
  const { openAuthModal } = useAuthModal();

  // Use optional board provider - allows TickAction to work outside board routes
  const boardProvider = useOptionalBoardProvider();
  const { status: sessionStatus } = useSession();
  const isAuthenticated = boardProvider?.isAuthenticated ?? sessionStatus === 'authenticated';
  const logbook = boardProvider?.logbook ?? EMPTY_LOGBOOK;

  // Fetch user's boards when we need the board selector (no existing BoardProvider + authenticated)
  const needsBoardSelector = !boardProvider && isAuthenticated;
  const { boards: myBoards, isLoading: isLoadingBoards } = useMyBoards(needsBoardSelector);

  // Track whether useMyBoards has completed its initial loading cycle.
  // useMyBoards starts with isLoading=false before the effect fires, creating a window
  // where {boards:[], isLoading:false} looks like "loaded empty" but is actually "not started".
  // We track when isLoading becomes true to distinguish these states.
  const hasStartedLoadingRef = useRef(false);
  if (isLoadingBoards) hasStartedLoadingRef.current = true;
  if (!needsBoardSelector) hasStartedLoadingRef.current = false;
  const boardsReady = hasStartedLoadingRef.current && !isLoadingBoards;

  // Filter boards to matching board type (e.g., only Kilter boards for a Kilter climb)
  const matchingBoards = useMemo(
    () => myBoards.filter((b) => b.boardType === boardDetails.board_name),
    [myBoards, boardDetails.board_name],
  );

  const { alwaysUseApp, loaded, enableAlwaysUseApp } = useAlwaysTickInApp();

  // Find ascent entries for this climb
  const filteredLogbook = useMemo(() => {
    if (!logbook || !climb) return [];
    return logbook.filter((asc) => asc.climb_uuid === climb.uuid && Number(asc.angle) === angle);
  }, [logbook, climb, angle]);

  const hasSuccessfulAscent = filteredLogbook.some((asc) => asc.is_ascent);
  const badgeCount = filteredLogbook.length;

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      track('Tick Button Clicked', {
        boardLayout: boardDetails.layout_name || '',
        existingAscentCount: badgeCount,
      });

      if (onTickAction) {
        onTickAction();
        return;
      }

      if (!isAuthenticated && alwaysUseApp && loaded) {
        const url = constructClimbInfoUrl(boardDetails, climb.uuid);
        if (url) {
          openExternalUrl(url);
          onComplete?.();
          return;
        }
      }

      setDrawerVisible(true);
    },
    [boardDetails, badgeCount, isAuthenticated, alwaysUseApp, loaded, climb.uuid, onComplete, onTickAction],
  );

  const closeDrawer = useCallback(() => {
    setDrawerVisible(false);
    setSelectedBoard(null);
    onComplete?.();
  }, [onComplete]);

  // URL for opening in the Aurora app (null for Kilter as app URL is no longer accessible)
  const openInAppUrl = useMemo(() => constructClimbInfoUrl(boardDetails, climb.uuid), [boardDetails, climb.uuid]);

  const handleOpenInApp = useCallback(() => {
    if (!openInAppUrl) return;
    openExternalUrl(openInAppUrl);
    closeDrawer();
  }, [openInAppUrl, closeDrawer]);

  const renderSignInPrompt = () => (
    <Stack spacing={3} sx={{ width: '100%', textAlign: 'center', padding: '24px 0' }}>
      <Typography variant="body2" component="span" fontWeight={600} sx={{ fontSize: 16 }}>
        Sign in to record ticks
      </Typography>
      <Typography variant="body1" component="p" color="text.secondary">
        Create a Boardsesh account to log your climbs and track your progress.
      </Typography>
      <MuiButton
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
      </MuiButton>
      {openInAppUrl && (
        <>
          <Typography variant="body1" component="p" color="text.secondary">
            Or log your tick in the official app:
          </Typography>
          <MuiButton variant="outlined" startIcon={<AppsOutlined />} onClick={handleOpenInApp} fullWidth>
            Open in App
          </MuiButton>
          <MuiButton
            variant="text"
            size="small"
            color="secondary"
            onClick={async () => {
              await enableAlwaysUseApp();
              handleOpenInApp();
            }}
          >
            Always open in app
          </MuiButton>
        </>
      )}
    </Stack>
  );

  const label = 'Log ascent';
  const shouldShowLabel = showLabel ?? (viewMode === 'button' || viewMode === 'dropdown');
  const iconSize = size === 'small' ? 14 : size === 'large' ? 20 : 16;

  const icon = <CheckOutlined sx={{ fontSize: iconSize }} />;
  const badgeColor = hasSuccessfulAscent ? themeTokens.colors.success : themeTokens.colors.error;

  // Whether to show the board selector or go straight to the form.
  // Show board selector when outside a board route, authenticated, and either still loading or have matching boards.
  const hasMatchingBoards = boardsReady && matchingBoards.length > 0;
  const noMatchingBoards = needsBoardSelector && boardsReady && matchingBoards.length === 0;
  const showBoardSelector = needsBoardSelector && !selectedBoard && (!boardsReady || hasMatchingBoards);

  const boardTypeLabel = boardDetails.board_name.charAt(0).toUpperCase() + boardDetails.board_name.slice(1);

  // When a user selects a board from the selector, use its config for the tick.
  // This ensures the tick is logged against the board the user actually climbed on.
  const effectiveBoardDetails: BoardDetails = useMemo(() => {
    if (!selectedBoard) return boardDetails;
    return {
      ...boardDetails,
      layout_id: selectedBoard.layoutId,
      size_id: selectedBoard.sizeId,
      set_ids: selectedBoard.setIds.split(',').map(Number),
      layout_name: selectedBoard.layoutName ?? boardDetails.layout_name,
      size_name: selectedBoard.sizeName ?? boardDetails.size_name,
      size_description: selectedBoard.sizeDescription ?? boardDetails.size_description,
      set_names: selectedBoard.setNames ?? boardDetails.set_names,
    };
  }, [selectedBoard, boardDetails]);

  // Validate the board name for the conditional BoardProvider
  const resolvedBoardName: BoardName = isValidBoardName(selectedBoard?.boardType ?? '')
    ? (selectedBoard!.boardType as BoardName)
    : boardDetails.board_name;

  const renderBoardSelector = () => (
    <Stack spacing={2} sx={{ py: 2 }}>
      <Typography variant="body2" fontWeight={600} sx={{ fontSize: 16, textAlign: 'center' }}>
        Which board did you climb on?
      </Typography>
      <BoardScrollSection loading={!boardsReady} size="small">
        {matchingBoards.map((board) => (
          <BoardScrollCard
            key={board.uuid}
            userBoard={board}
            size="small"
            selected={selectedBoard?.uuid === board.uuid}
            onClick={() => setSelectedBoard(board)}
          />
        ))}
      </BoardScrollSection>
    </Stack>
  );

  const renderLogAscentForm = () => (
    <LogAscentForm currentClimb={climb} boardDetails={effectiveBoardDetails} onClose={closeDrawer} />
  );

  const renderNoMatchingBoardsMessage = () => (
    <Stack spacing={2} sx={{ py: 2, textAlign: 'center' }}>
      <Typography variant="body2" color="text.secondary">
        {`You don\u2019t have any ${boardTypeLabel} boards saved yet. Logging tick for ${boardTypeLabel}.`}
      </Typography>
    </Stack>
  );

  const drawers = boardProvider ? (
    // Inside a board route - existing flow unchanged
    isAuthenticated ? (
      <LogAscentDrawer open={drawerVisible} onClose={closeDrawer} currentClimb={climb} boardDetails={boardDetails} />
    ) : (
      <SwipeableDrawer
        title="Sign In Required"
        placement="bottom"
        onClose={closeDrawer}
        open={drawerVisible}
        styles={{ wrapper: { height: '60%' } }}
      >
        {renderSignInPrompt()}
      </SwipeableDrawer>
    )
  ) : isAuthenticated ? (
    // Outside board route, authenticated - board selector + log form
    <SwipeableDrawer
      title={showBoardSelector ? 'Select Board' : 'Log Ascent'}
      placement="bottom"
      onClose={closeDrawer}
      open={drawerVisible}
      fullHeight={!showBoardSelector}
      styles={{ wrapper: { height: showBoardSelector ? '60%' : '100%' } }}
    >
      {showBoardSelector ? (
        renderBoardSelector()
      ) : (
        <BoardProvider boardName={resolvedBoardName}>
          {noMatchingBoards && renderNoMatchingBoardsMessage()}
          {renderLogAscentForm()}
        </BoardProvider>
      )}
    </SwipeableDrawer>
  ) : (
    // Outside board route, not authenticated - sign-in prompt
    <SwipeableDrawer
      title="Sign In Required"
      placement="bottom"
      onClose={closeDrawer}
      open={drawerVisible}
      styles={{ wrapper: { height: '60%' } }}
    >
      {renderSignInPrompt()}
    </SwipeableDrawer>
  );

  // Icon mode - for Card actions
  const iconElement = (
    <>
      <ActionTooltip title={label}>
        <MuiBadge
          badgeContent={badgeCount}
          max={99}
          sx={{ '& .MuiBadge-badge': { backgroundColor: badgeColor, color: 'common.white' } }}
        >
          <Box component="span" onClick={handleClick} sx={{ cursor: 'pointer' }} className={className}>
            {icon}
          </Box>
        </MuiBadge>
      </ActionTooltip>
      {drawers}
    </>
  );

  // Button mode
  const buttonElement = (
    <>
      <MuiBadge
        badgeContent={badgeCount}
        max={99}
        sx={{ '& .MuiBadge-badge': { backgroundColor: badgeColor, color: 'common.white' } }}
      >
        <MuiButton
          variant="outlined"
          startIcon={icon}
          onClick={handleClick}
          size={size === 'large' ? 'large' : 'small'}
          disabled={disabled}
          className={className}
        >
          {shouldShowLabel && label}
        </MuiButton>
      </MuiBadge>
      {drawers}
    </>
  );

  // Menu item for dropdown
  const menuItem = {
    key: 'tick',
    label: badgeCount > 0 ? `${label} (${badgeCount})` : label,
    icon,
    onClick: () => handleClick(),
  };

  // List mode - full-width row for drawer menus
  const listElement = (
    <>
      <MuiButton
        variant="text"
        startIcon={icon}
        fullWidth
        onClick={handleClick}
        disabled={disabled}
        sx={{
          height: 48,
          justifyContent: 'flex-start',
          paddingLeft: `${themeTokens.spacing[4]}px`,
          fontSize: themeTokens.typography.fontSize.base,
          color: 'text.primary',
          '& .MuiButton-startIcon': {
            color: 'text.secondary',
          },
          '&:hover': {
            backgroundColor: 'action.hover',
          },
        }}
      >
        {badgeCount > 0 ? `${label} (${badgeCount})` : label}
      </MuiButton>
      {drawers}
    </>
  );

  let element: React.ReactNode;
  switch (viewMode) {
    case 'icon':
      element = iconElement;
      break;
    case 'button':
    case 'compact':
      element = buttonElement;
      break;
    case 'list':
      element = listElement;
      break;
    case 'dropdown':
      element = drawers; // Need to render drawers even in dropdown mode
      break;
    default:
      element = iconElement;
  }

  return {
    element,
    menuItem,
    key: 'tick',
    available: true,
  };
}

export default TickAction;
