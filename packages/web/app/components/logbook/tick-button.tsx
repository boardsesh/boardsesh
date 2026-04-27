'use client';

import React, { useState, useMemo } from 'react';
import type { Angle, Climb, BoardDetails } from '@/app/lib/types';
import { useBoardProvider } from '../board-provider/board-provider-context';
import MuiBadge from '@mui/material/Badge';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import { track } from '@/app/lib/analytics';
import { LogAscentDrawer } from './log-ascent-drawer';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
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
  const { openAuthModal } = useAuthModal();
  const { alwaysUseApp, loaded, enableAlwaysUseApp } = useAlwaysTickInApp();

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

    // Use inline tick bar when available and authenticated
    if (isAuthenticated && onActivateTickBar) {
      onActivateTickBar();
      return;
    }

    setDrawerVisible(true);
  };
  const closeDrawer = () => setDrawerVisible(false);

  const handleOpenInApp = () => {
    if (!openInAppUrl) return;
    openExternalUrl(openInAppUrl);
    closeDrawer();
  };

  const filteredLogbook = useMemo(
    () => logbook.filter((asc) => asc.climb_uuid === currentClimb?.uuid && Number(asc.angle) === angle),
    [logbook, currentClimb?.uuid, angle],
  );
  const hasSuccessfulAscent = filteredLogbook.some((asc) => asc.is_ascent);
  const badgeCount = filteredLogbook.length;

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
        sx={
          tickBarActive
            ? {
                backgroundColor:
                  ascentType === 'attempt'
                    ? themeTokens.colors.error
                    : ascentType === 'flash' || isFlash
                      ? themeTokens.colors.amber
                      : themeTokens.colors.success,
                color: ascentType === 'flash' || isFlash ? themeTokens.neutral[900] : 'common.white',
                transition: 'background-color 150ms ease, color 150ms ease',
                '&:hover': {
                  backgroundColor:
                    ascentType === 'attempt'
                      ? themeTokens.colors.error
                      : ascentType === 'flash' || isFlash
                        ? themeTokens.colors.amber
                        : themeTokens.colors.successHover,
                },
              }
            : { opacity: themeTokens.opacity.subtle }
        }
      >
        {tickBarActive && ascentType === 'attempt' ? (
          <PersonFallingIcon />
        ) : (
          <TickIcon isFlash={tickBarActive ? !!(ascentType === 'flash' || isFlash) : false} />
        )}
      </IconButton>
    </MuiBadge>
  );

  const tickLabel = ascentType === 'attempt' ? 'attempt' : ascentType === 'flash' || isFlash ? 'flash' : 'tick';

  return (
    <>
      {tickBarActive ? <TickButtonWithLabel label={tickLabel}>{badge}</TickButtonWithLabel> : badge}

      {isAuthenticated ? (
        <LogAscentDrawer
          open={drawerVisible}
          onClose={closeDrawer}
          currentClimb={currentClimb}
          boardDetails={boardDetails}
        />
      ) : (
        <SwipeableDrawer
          title="Sign In Required"
          placement="bottom"
          onClose={closeDrawer}
          open={drawerVisible}
          styles={{ wrapper: { height: '60%' } }}
        >
          <Stack spacing={3} sx={{ width: '100%', textAlign: 'center', padding: '24px 0' }}>
            <Typography variant="body2" component="span" fontWeight={600} sx={{ fontSize: 16 }}>
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
            {openInAppUrl && (
              <>
                <Typography variant="body1" component="p" color="text.secondary">
                  Or log your tick in the official app:
                </Typography>
                <Button variant="outlined" startIcon={<AppsOutlined />} onClick={handleOpenInApp} fullWidth>
                  Open in App
                </Button>
                <Button
                  variant="text"
                  size="small"
                  color="secondary"
                  onClick={async () => {
                    await enableAlwaysUseApp();
                    handleOpenInApp();
                  }}
                >
                  Always open in app
                </Button>
              </>
            )}
          </Stack>
        </SwipeableDrawer>
      )}
    </>
  );
};
