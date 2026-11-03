import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { announceQueued } from '../../lib/announce-queued';
import { hapticLight } from '../../lib/haptics';
import {
  getDriveLightingSnapshot,
  getLastDriveEnded,
  getLastDriveEndedAt,
  stopDrivingForLink,
  type DriveEnded,
} from '../play-drawer/drive-mode-store';
import { DISCONNECT_TAP_GUARD_MS, WINDOW_END_TAP_GRACE_MS } from '../play-drawer/drive-tap-guards';
import { resolveBulbDriveCue } from './bulb-drive-cue';

/**
 * What a tap on a MiniPlayer bulb does while this phone drives the wall (owner,
 * 2026-11-03: a tap in the 45 s drive should only stop driving, not also
 * disconnect). The bar's own bulb (`BoardControlIndicator`) and the last
 * pick's Put on board bulb (`PickPutOnBoardBulb`) read it, on the iOS 26
 * accessory and the floating bar alike. The tablet and open-Duo bulb runs the
 * player's handler instead, whose `tapAction` stops a drive the same way.
 *
 * - `stop_driving` — the bulb draws this phone's drive (`BulbDriveCue`: Put on
 *   board's timed drive, an open-ended drive, Always drive the wall's): stop
 *   driving and keep the link, the frosted button's own stop
 *   (`stopDrivingForLink`, Drive Mode Ended `stopped`). Under Always drive the
 *   wall the stop holds until the link drops or the next Put on board. With
 *   Disconnect Bluetooth when driving ends on, the board is let go of all the
 *   same: that is the climber's setting.
 * - `held` — dropped: the second tap of a double tap whose first stopped a
 *   drive (`DISCONNECT_TAP_GUARD_MS`), or a tap aimed at the draining ring that
 *   landed just after the timed drive ran out (`WINDOW_END_TAP_GRACE_MS`).
 *   Either would otherwise hang up, reconnect, or put a climb up and start a
 *   fresh drive, the opposite of the stop the climber meant.
 * - `own` — no drive: the bulb's own tap, as before (hang up, connect, take or
 *   release a wall with no lights, or Put on board for the last pick).
 */
export type BarBulbTap = 'stop_driving' | 'held' | 'own';

export function resolveBarBulbTap({
  drawsDrive,
  lastEnded,
  lastEndedAt,
  now,
}: {
  /** The bulb draws this phone's drive: its `BulbDriveCue` is not null. */
  drawsDrive: boolean;
  /** The last drive end handed on (`getLastDriveEnded`). */
  lastEnded: Pick<DriveEnded, 'reason'> | null;
  /** When it was handed on (`getLastDriveEndedAt`). */
  lastEndedAt: number | null;
  now: number;
}): BarBulbTap {
  if (drawsDrive) return 'stop_driving';
  if (lastEnded === null || lastEndedAt === null) return 'own';
  const sinceEnd = now - lastEndedAt;
  // A clock that moved back since the end: no guard to apply.
  if (sinceEnd < 0) return 'own';
  if (lastEnded.reason === 'stopped' && sinceEnd < DISCONNECT_TAP_GUARD_MS) return 'held';
  if (lastEnded.reason === 'window_ended' && sinceEnd < WINDOW_END_TAP_GRACE_MS) return 'held';
  return 'own';
}

/**
 * {@link resolveBarBulbTap} at the press, read from the drive store as it is
 * now rather than as the bar last rendered: a drive that ended between the
 * render and the press is not one to stop, and its end guards the tap instead.
 * `drivesTheWall` is the bulb's own reading (`phoneDrivesTheWall`).
 */
export function readBarBulbTap(drivesTheWall: boolean, now = Date.now()): BarBulbTap {
  const cue = resolveBulbDriveCue({ mode: getDriveLightingSnapshot().mode, drivesTheWall, showsLitClimb: true });
  return resolveBarBulbTap({
    drawsDrive: cue !== null,
    lastEnded: getLastDriveEnded(),
    lastEndedAt: getLastDriveEndedAt(),
    now,
  });
}

/**
 * A bar bulb's stop, as the frosted button's: a light buzz (nothing was let
 * go), the stop, and "Stopped driving the wall" for a screen reader.
 */
export function useBarBulbStopDriving(): () => void {
  const { t } = useTranslation('session');
  return useCallback(() => {
    hapticLight();
    stopDrivingForLink();
    announceQueued(t('playView.wallControl.stoppedDriving'));
  }, [t]);
}
