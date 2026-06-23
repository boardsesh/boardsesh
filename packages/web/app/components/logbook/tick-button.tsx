'use client';

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Angle, Climb, BoardDetails } from '@/app/lib/types';
import { useBoardProvider } from '../board-provider/board-provider-context';
import MuiBadge from '@mui/material/Badge';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import type { SxProps, Theme } from '@mui/material/styles';
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
  const { t } = useTranslation('climbs');
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

  let buttonSx: SxProps<Theme>;
  if (!tickBarActive) {
    buttonSx = { opacity: themeTokens.opacity.subtle };
  } else {
    const isFlashVariant = ascentType === 'flash' || isFlash;
    let backgroundColor: string;
    let hoverBackgroundColor: string;
    if (ascentType === 'attempt') {
      backgroundColor = 'var(--color-error)';
      hoverBackgroundColor = 'var(--color-error)';
    } else if (isFlashVariant) {
      backgroundColor = themeTokens.colors.amber;
      hoverBackgroundColor = themeTokens.colors.amber;
    } else {
      backgroundColor = 'var(--color-success)';
      hoverBackgroundColor = 'var(--color-success-hover)';
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
          backgroundColor: hasSuccessfulAscent ? 'var(--color-success)' : 'var(--color-error)',
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

      {isAuthenticated ? (
        <LogAscentDrawer
          open={drawerVisible}
          onClose={closeDrawer}
          currentClimb={currentClimb}
          boardDetails={boardDetails}
        />
      ) : (
        <SwipeableDrawer
          title={t('actions.tick.drawer.signInRequired')}
          placement="bottom"
          onClose={closeDrawer}
          open={drawerVisible}
          styles={{ wrapper: { height: '60%' } }}
        >
          <Stack spacing={3} sx={{ width: '100%', textAlign: 'center', padding: '24px 0' }}>
            <Typography variant="body2" component="span" fontWeight={600} sx={{ fontSize: 16 }}>
              {t('actions.tick.drawer.signInToRecord')}
            </Typography>
            <Typography variant="body1" component="p" color="text.secondary">
              {t('actions.tick.drawer.createAccountBlurb')}
            </Typography>
            <Button
              variant="contained"
              startIcon={<LoginOutlined />}
              onClick={() =>
                openAuthModal({
                  title: t('actions.tick.drawer.authModalTitle'),
                  description: t('actions.tick.drawer.authModalDescription'),
                })
              }
              fullWidth
            >
              {t('actions.tick.drawer.signIn')}
            </Button>
            {openInAppUrl && (
              <>
                <Typography variant="body1" component="p" color="text.secondary">
                  {t('actions.tick.drawer.orLogInOfficialApp')}
                </Typography>
                <Button variant="outlined" startIcon={<AppsOutlined />} onClick={handleOpenInApp} fullWidth>
                  {t('actions.tick.drawer.openInApp')}
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
                  {t('actions.tick.drawer.alwaysOpenInApp')}
                </Button>
              </>
            )}
          </Stack>
        </SwipeableDrawer>
      )}
    </>
  );
};
