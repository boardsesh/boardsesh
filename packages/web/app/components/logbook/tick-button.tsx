'use client';

import React, { useState, useMemo } from 'react';
import type { Angle, Climb, BoardDetails } from '@/app/lib/types';
import { useBoardProvider } from '../board-provider/board-provider-context';
import MuiBadge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import type { SxProps, Theme } from '@mui/material/styles';
import { track } from '@/app/lib/analytics';
import { LogAscentDrawer } from './log-ascent-drawer';
import { constructClimbInfoUrl } from '@/app/lib/url-utils';
import { openExternalUrl } from '@/app/lib/open-external-url';
import { themeTokens } from '@/app/theme/theme-config';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import { useAlwaysTickInApp } from '@/app/hooks/use-always-tick-in-app';
import { TickIcon, TickButtonWithLabel } from './tick-icon';

type TickButtonProps = {
  angle: Angle;
  currentClimb: Climb | null;
  boardDetails: BoardDetails;
  onActivateTickBar?: () => void;
  /** Called when the tick button is pressed while tick mode is already active (saves the tick). */
  onTickSave?: (originElement?: HTMLElement) => void;
  tickBarActive?: boolean;
  /** Whether the current tick will be logged as a flash (no prior history, 1 try). */
  isFlash?: boolean;
  /** The currently selected ascent type in the expanded tick bar. */
  ascentType?: 'flash' | 'send' | 'attempt';
};

export const TickButton: React.FC<TickButtonProps> = ({
  currentClimb,
  angle,
  boardDetails,
  onActivateTickBar,
  onTickSave,
  tickBarActive,
  isFlash,
  ascentType,
}) => {
  const { logbook, isAuthenticated } = useBoardProvider();
  const [drawerVisible, setDrawerVisible] = useState(false);
  const { alwaysUseApp, loaded } = useAlwaysTickInApp();

  // URL for opening in the Aurora app (null for Kilter as app URL is no longer accessible)
  const openInAppUrl = useMemo(
    () => (currentClimb ? constructClimbInfoUrl(boardDetails, currentClimb.uuid) : null),
    [boardDetails, currentClimb],
  );

  const showDrawer = (e?: React.MouseEvent<HTMLButtonElement>) => {
    track('Tick Button Clicked', {
      boardLayout: boardDetails.layout_name || '',
      existingAscentCount: badgeCount,
    });

    // When tick mode is already active, save the tick
    if (tickBarActive && onTickSave) {
      onTickSave(e?.currentTarget);
      return;
    }

    if (!isAuthenticated && alwaysUseApp && loaded && openInAppUrl) {
      openExternalUrl(openInAppUrl);
      return;
    }

    // Use inline tick bar when available — works for signed-in and signed-out users.
    if (onActivateTickBar) {
      onActivateTickBar();
      return;
    }

    setDrawerVisible(true);
  };
  const closeDrawer = () => setDrawerVisible(false);

  const filteredLogbook = useMemo(
    () => logbook.filter((asc) => asc.climb_uuid === currentClimb?.uuid && Number(asc.angle) === angle),
    [logbook, currentClimb?.uuid, angle],
  );
  const hasSuccessfulAscent = filteredLogbook.some((asc) => asc.is_ascent);
  const badgeCount = filteredLogbook.length;

  let buttonSx: SxProps<Theme>;
  if (!tickBarActive) {
    buttonSx = { opacity: themeTokens.opacity.subtle };
  } else {
    const isFlashVariant = ascentType === 'flash' || isFlash;
    let backgroundColor: string;
    let hoverBackgroundColor: string;
    if (ascentType === 'attempt') {
      backgroundColor = themeTokens.colors.error;
      hoverBackgroundColor = themeTokens.colors.error;
    } else if (isFlashVariant) {
      backgroundColor = themeTokens.colors.amber;
      hoverBackgroundColor = themeTokens.colors.amber;
    } else {
      backgroundColor = themeTokens.colors.success;
      hoverBackgroundColor = themeTokens.colors.successHover;
    }
    buttonSx = {
      backgroundColor,
      color: isFlashVariant ? themeTokens.neutral[900] : 'common.white',
      transition: 'background-color 150ms ease, color 150ms ease',
      '&:hover': {
        backgroundColor: hoverBackgroundColor,
      },
    };
  }

  const badge = (
    <MuiBadge
      badgeContent={badgeCount > 0 ? badgeCount : 0}
      max={100}
      sx={{
        '& .MuiBadge-badge': {
          backgroundColor: hasSuccessfulAscent ? themeTokens.colors.success : themeTokens.colors.error,
          color: 'common.white',
        },
      }}
    >
      <IconButton
        id="button-tick"
        onClick={showDrawer}
        aria-label={tickBarActive ? 'Save tick' : 'Log ascent'}
        sx={buttonSx}
      >
        {tickBarActive && ascentType === 'attempt' ? (
          <PersonFallingIcon />
        ) : (
          <TickIcon isFlash={tickBarActive ? !!(ascentType === 'flash' || isFlash) : false} />
        )}
      </IconButton>
    </MuiBadge>
  );

  let tickLabel: 'flash' | 'tick' | 'attempt';
  if (ascentType === 'attempt') {
    tickLabel = 'attempt';
  } else if (ascentType === 'flash' || isFlash) {
    tickLabel = 'flash';
  } else {
    tickLabel = 'tick';
  }

  return (
    <>
      {tickBarActive ? <TickButtonWithLabel label={tickLabel}>{badge}</TickButtonWithLabel> : badge}

      <LogAscentDrawer
        open={drawerVisible}
        onClose={closeDrawer}
        currentClimb={currentClimb}
        boardDetails={boardDetails}
      />
    </>
  );
};
