import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { announceQueued } from '../../lib/announce-queued';
import { trackWallControlTapped, type StandaloneBulbSurface } from '../../lib/analytics-wall-control';
import { hapticLight } from '../../lib/haptics';
import { getSetting } from '../../settings';
import {
  getDriveLightingSnapshot,
  getLastDriveEnded,
  getLastDriveEndedAt,
  stopDrivingForLink,
  useDriveLightingMode,
  type DriveEnded,
} from '../play-drawer/drive-mode-store';
import { DISCONNECT_TAP_GUARD_MS, WINDOW_END_TAP_GRACE_MS } from '../play-drawer/drive-tap-guards';
import { resolveBulbDriveCue } from './bulb-drive-cue';

/**
 * What a tap on a bulb outside the player does while this phone drives the
 * wall (owner, 2026-11-03: a tap in the 45 s drive should only stop driving,
 * not also disconnect; then "Yes, every bulb"). The bar's own bulb
 * (`BoardControlIndicator`) and the last pick's Put on board bulb
 * (`PickPutOnBoardBulb`) read it, on the iOS 26 accessory and the floating bar
 * alike, and so do the toolbar's, the Android app bar's, the header pill's and
 * the create-climb editor's (`useBulbDriveTap`). The tablet and open-Duo bulb,
 * and the player's own first-row bulb, run the player's handler instead, whose
 * `tapAction` stops a drive the same way.
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

/** Which bulb stopped the drive, for Wall Control Tapped's `control`. */
export type BulbStopSurface = 'mini_bar' | StandaloneBulbSurface;

/**
 * A "Board disconnected" that a bulb's stop still owes after the bulb itself
 * went. The header pill shows only while this phone holds the board, so it goes
 * in the same render as the link drops and never sees the drop it asked to
 * have said; the Climbs header that drew it says it instead
 * (`useOwedDropAnnouncement`). A new link forgets it (`forgetOwedDropOnRelink`):
 * the drop it was owed for came and went unsaid, and a later one is not its.
 */
let owedDrop = false;

/**
 * A link that came back since the last render: whatever drop was owed has
 * already happened, so a later drop is not that stop's to say. Read by the
 * Climbs header and every bulb, so the first one there to see the relink
 * clears it.
 */
function forgetOwedDropOnRelink(wasLinked: boolean, linked: boolean): void {
  if (!wasLinked && linked) owedDrop = false;
}

/** Tests only: nothing owed. */
export function resetOwedDropForTests(): void {
  owedDrop = false;
}

/**
 * Says the drop a gone bulb's stop owed, once, when this phone's link drops.
 * Mounted where the screen outlives its bulb: the Climbs header
 * (`ClimbTopChrome`), for its You have the board pill.
 */
export function useOwedDropAnnouncement(linked: boolean): void {
  const { t } = useTranslation('settings');
  const wasLinkedRef = useRef(linked);
  useEffect(() => {
    const wasLinked = wasLinkedRef.current;
    wasLinkedRef.current = linked;
    forgetOwedDropOnRelink(wasLinked, linked);
    if (!wasLinked || linked || !owedDrop) return;
    owedDrop = false;
    announceQueued(t('ble.barControl.disconnectedLabel'));
  }, [linked, t]);
}

/**
 * A bulb's stop, as the frosted button's: a light buzz (nothing was let go),
 * the stop, and "Stopped driving the wall" for a screen reader.
 *
 * It logs Wall Control Tapped as the tablet's bulb does (`state: 'lit'`,
 * `stop_window` during Put on board's timed drive, otherwise `stop_driving`),
 * with the bulb as `control`: `mini_bar` for the bar's bulbs, so a bar stop
 * counts the same on a phone and a tablet, or `toolbar`, `app_bar`,
 * `header_pill` or `create_climb`. Each reads apart from the frosted button's
 * (`button`).
 *
 * With Disconnect Bluetooth when driving ends on, the stop lets go of the board
 * too (`DriveModeWatcher`): a screen reader hears "Board disconnected" once the
 * link actually drops, as after the frosted button's stop, not at the tap.
 * `linked` is this phone's own Bluetooth link (`localConnected`).
 */
export function useBarBulbStopDriving(linked: boolean, control: BulbStopSurface): () => void {
  const { t } = useTranslation('session');
  const { t: tSettings } = useTranslation('settings');
  const wasLinkedRef = useRef(linked);
  const announceDropRef = useRef(false);
  useEffect(() => {
    const wasLinked = wasLinkedRef.current;
    wasLinkedRef.current = linked;
    forgetOwedDropOnRelink(wasLinked, linked);
    const dropped = wasLinked && !linked;
    if (!dropped || !announceDropRef.current) return;
    announceDropRef.current = false;
    announceQueued(tSettings('ble.barControl.disconnectedLabel'));
  }, [linked, tSettings]);
  // Gone before the link dropped (the header pill goes with the hold): the
  // screen that drew it says the drop instead. React runs this before the
  // header's own effect for that drop, in the same commit.
  useEffect(
    () => () => {
      if (announceDropRef.current) owedDrop = true;
    },
    [],
  );
  return useCallback(() => {
    // Read before the stop: the drive it ends says which stop this was.
    const action = getDriveLightingSnapshot().mode === 'window' ? 'stop_window' : 'stop_driving';
    trackWallControlTapped({ state: 'lit', action, control });
    if (wasLinkedRef.current && getSetting('disconnectWhenDrivingEnds') === true) announceDropRef.current = true;
    hapticLight();
    stopDrivingForLink();
    announceQueued(t('playView.wallControl.stoppedDriving'));
  }, [control, t]);
}

/** A standalone bulb's drive, and the tap that goes ahead of its own (`useBulbDriveTap`). */
export type BulbDriveTap = {
  /**
   * This phone drives the wall now (a timed drive, an open-ended one, Always
   * drive the wall's): the bulb says "Stop driving", since that is its tap.
   */
  driving: boolean;
  /**
   * Run at the press, before the bulb's own tap: stops a drive, or drops a
   * guarded tap (`resolveBarBulbTap`'s `held`). True when the tap was taken
   * here and the bulb's own tap must not run.
   */
  takeTap: () => boolean;
};

/**
 * Every bulb stops a drive (owner, 2026-11-03): the toolbar's (`toolbar`, the
 * glass button and the rail's native item), the Android app bar's (`app_bar`),
 * the Climbs header's You have the board pill (`header_pill`) and the
 * create-climb editor's (`create_climb`) take the bar's rule. During a drive a
 * tap stops driving and keeps the link (`useBarBulbStopDriving`); just after
 * one it drops the taps the bar drops; otherwise the bulb's own tap runs, as
 * before (hang up, connect, take or release a wall with no lights).
 * `drivesTheWall` is the bulb's own reading (`phoneDrivesTheWall`), `linked`
 * this phone's Bluetooth link.
 */
export function useBulbDriveTap({
  drivesTheWall,
  linked,
  control,
}: {
  drivesTheWall: boolean;
  linked: boolean;
  control: StandaloneBulbSurface;
}): BulbDriveTap {
  const mode = useDriveLightingMode();
  const stopDriving = useBarBulbStopDriving(linked, control);
  const driving = resolveBulbDriveCue({ mode, drivesTheWall, showsLitClimb: true }) !== null;
  const takeTap = useCallback(() => {
    const tap = readBarBulbTap(drivesTheWall);
    if (tap === 'stop_driving') stopDriving();
    return tap !== 'own';
  }, [drivesTheWall, stopDriving]);
  return { driving, takeTap };
}
