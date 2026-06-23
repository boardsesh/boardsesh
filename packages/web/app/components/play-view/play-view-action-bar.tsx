'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MuiBadge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import Favorite from '@mui/icons-material/Favorite';
import SkipPreviousOutlined from '@mui/icons-material/SkipPreviousOutlined';
import SkipNextOutlined from '@mui/icons-material/SkipNextOutlined';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import Lightbulb from '@mui/icons-material/Lightbulb';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import { useLongPress } from '@/app/lib/hooks/use-long-press';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './play-view-drawer.module.css';

export type PlayViewActionBarProps = {
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  isMirrored: boolean;
  supportsMirroring: boolean;
  isFavorited: boolean;
  remainingQueueCount: number;
  onPrevClick: () => void;
  onNextClick: () => void;
  onMirror: () => void;
  onToggleFavorite: () => void;
  onOpenActions: () => void;
  onOpenQueue: () => void;
  /** Whether the lightbulb should render as filled/lit (the visual). In party
   *  this is the session-scoped `wallConfirmed` indicator OR'd with this
   *  device's BLE / the board-presence holder; in solo it's
   *  `isBluetoothConnected`. Visual only — the tap action keys on
   *  `lightbulbConnected` (this device's BLE), not this. */
  lightbulbActive: boolean;
  /** Whether THIS device's BLE link is connected. Drives the tap action's
   *  meaning (and its aria label): connected → tapping disconnects ("turn off");
   *  not connected → tapping connects + sends ("send to the wall"). Distinct
   *  from `lightbulbActive`, which can be lit by a peer/board-presence holder. */
  lightbulbConnected: boolean;
  /** Pulse the lightbulb while a send press is in flight. Set between the
   *  press and the matching `WallConfirmedClimb` event (or the 2-second
   *  timeout fallback). Independent from `lightbulbActive`. */
  lightbulbPending?: boolean;
  /** Single-iteration pulse + tooltip on first drawer open. The parent
   *  reads `swipeHint:lightbulbSeen` from IndexedDB and toggles this true
   *  once, then writes the flag so subsequent opens skip the coachmark. */
  lightbulbCoachmark?: boolean;
  /** Localized tooltip copy for the coachmark. Threaded through so the
   *  parent owns the i18n call and this component stays presentational. */
  lightbulbCoachmarkText?: string;
  /** Fired when the coachmark animation runs once — the parent persists
   *  the seen flag and clears `lightbulbCoachmark`. */
  onLightbulbCoachmarkSeen?: () => void;
  /** Name of the currently displayed climb. Used in the lightbulb's aria
   *  label so screen-reader users hear what they're sending. */
  displayedClimbName: string | null;
  /** Lightbulb gesture: send / re-assert the displayed climb to the wall
   *  (connecting first if needed). In party it also broadcasts the climb so
   *  every member follows. Always-live — no driver claim. */
  onLightbulb: () => void;
  /** Long-press the lightbulb to open the light-control drawer (disco, party
   *  glyphs, palette, and the manual BLE disconnect). Optional — when the
   *  parent doesn't supply it, long-press is a no-op. */
  onLightbulbLongPress?: () => void;
  angleSelector?: React.ReactNode;
};

export const PlayViewActionBar = React.memo(function PlayViewActionBar({
  canSwipePrevious,
  canSwipeNext,
  isMirrored,
  supportsMirroring,
  isFavorited,
  remainingQueueCount,
  onPrevClick,
  onNextClick,
  onMirror,
  onToggleFavorite,
  onOpenActions,
  onOpenQueue,
  lightbulbActive,
  lightbulbConnected,
  lightbulbPending = false,
  lightbulbCoachmark = false,
  lightbulbCoachmarkText,
  onLightbulbCoachmarkSeen,
  displayedClimbName,
  onLightbulb,
  onLightbulbLongPress,
  angleSelector,
}: PlayViewActionBarProps) {
  const { t } = useTranslation('session');
  // Lightbulb aria label — the lightbulb is a connect/disconnect toggle keyed on
  // THIS device's BLE link (not the filled `lightbulbActive` visual, which a
  // peer/board-presence holder can light). Connected → tapping disconnects
  // ("turn off the board"); not connected → tapping connects + sends.
  const lightbulbLabel = lightbulbConnected
    ? t('playView.actionBar.lightbulb.turnOff')
    : displayedClimbName
      ? t('playView.actionBar.lightbulb.sendNamed', { name: displayedClimbName })
      : t('playView.actionBar.lightbulb.send');
  // Long-press the lightbulb to reach the light-control drawer (and the
  // manual BLE disconnect that lives inside it). Tap stays the send/connect
  // gesture; consumeLongPress() in the click handler swallows the synthesized
  // click that follows a long-press so we don't fire both.
  const { ref: lightbulbLongPressRef, consumeLongPress } = useLongPress<HTMLButtonElement>(onLightbulbLongPress);
  const handleLightbulbTap = useCallback(() => {
    if (consumeLongPress()) return;
    onLightbulb();
  }, [consumeLongPress, onLightbulb]);
  return (
    <div className={styles.actionBar}>
      <IconButton disabled={!canSwipePrevious} onClick={onPrevClick}>
        <SkipPreviousOutlined />
      </IconButton>
      {supportsMirroring && (
        <IconButton
          color={isMirrored ? 'primary' : 'default'}
          onClick={onMirror}
          sx={
            isMirrored
              ? {
                  backgroundColor: themeTokens.colors.purple,
                  borderColor: themeTokens.colors.purple,
                  color: 'common.white',
                  '&:hover': { backgroundColor: themeTokens.colors.purple },
                }
              : undefined
          }
        >
          <SyncOutlined />
        </IconButton>
      )}
      <IconButton onClick={onToggleFavorite}>
        {isFavorited ? <Favorite sx={{ color: 'var(--color-error)' }} /> : <FavoriteBorderOutlined />}
      </IconButton>
      {/* Lightbulb: the primary "send to the wall" gesture.
          Filled+amber-glowing when the lightbulb is active (wall confirmed in
          party, BLE-paired in solo); outlined when inactive (wall not confirmed
          in party, unpaired in solo). The warm-amber styling matches the ShareBoardButton
          that this drawer replaced — it reads as "this bulb is lit" rather
          than the dusty-rose primary, which the user kept misreading as an
          error state. Long-press opens the light-control drawer (disco /
          glyphs / palette / manual disconnect).

          Pending / coachmark variants share a single CSS pulse class so the
          two states never compose into a janky doubled animation. */}
      <Tooltip
        // Coachmark tooltip only — once `lightbulbCoachmark` flips false the
        // tooltip is gone (default-closed Tooltip with no children-trigger).
        open={lightbulbCoachmark && !!lightbulbCoachmarkText}
        title={lightbulbCoachmarkText ?? ''}
        placement="top"
        arrow
        // Tooltip-only — the underlying button still owns its aria-label.
        disableInteractive
      >
        <IconButton
          ref={lightbulbLongPressRef}
          onClick={handleLightbulbTap}
          aria-label={lightbulbLabel}
          className={
            lightbulbPending ? styles.lightbulbPending : lightbulbCoachmark ? styles.lightbulbCoachmark : undefined
          }
          onAnimationEnd={lightbulbCoachmark ? onLightbulbCoachmarkSeen : undefined}
        >
          {lightbulbActive ? (
            <Lightbulb className={styles.lightbulbConnectedGlow} sx={{ color: 'var(--color-warning)' }} />
          ) : (
            <LightbulbOutlined />
          )}
        </IconButton>
      </Tooltip>
      {angleSelector}
      <IconButton onClick={onOpenActions} aria-label={t('playView.actionBar.climbActionsAria')}>
        <MoreHorizOutlined />
      </IconButton>
      <MuiBadge
        badgeContent={remainingQueueCount}
        max={99}
        sx={{
          '& .MuiBadge-badge': {
            backgroundColor: 'var(--color-primary-fill)',
            color: 'common.white',
          },
        }}
      >
        <IconButton onClick={onOpenQueue} aria-label={t('playView.actionBar.openQueueAria')}>
          <FormatListBulletedOutlined />
        </IconButton>
      </MuiBadge>
      <IconButton disabled={!canSwipeNext} onClick={onNextClick}>
        <SkipNextOutlined />
      </IconButton>
    </div>
  );
});
PlayViewActionBar.displayName = 'PlayViewActionBar';
