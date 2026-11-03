import type { AnalyticsEventProperties, WallControlPreviewReason } from '@boardsesh/analytics';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { announceQueued } from '../../lib/announce-queued';
import { noteWallPutOnBoardPress } from '../../lib/wall-swipe-hint';
import {
  trackWallControlSwiped,
  trackWallControlTapped,
  type WallControlSurface,
} from '../../lib/analytics-wall-control';
import { trackBoardControlsOpened } from '../../lib/analytics-board-connect';
import type { DriveModeStartedBy } from '@boardsesh/analytics';
import { hapticLight, hapticMedium, hapticSuccess, hapticWarning } from '../../lib/haptics';
import type { KeepLightingPlan } from '../../lib/keep-lighting';
import { getSetting } from '../../settings';
import {
  claimDriveAnnouncement,
  clearDrivingStopped,
  getDriveMode,
  getLastDriveEnded,
  getLastDriveModeExitReason,
  stopDrivingForLink,
  useDriveLightingMode,
} from './drive-mode-store';
import { DISCONNECT_TAP_GUARD_MS, WINDOW_END_TAP_GRACE_MS } from './drive-tap-guards';
import { shouldDisconnectWhenDrivingEnds } from './use-driving-ended-disconnect';
import { useWallControlShown } from './use-wall-control-shown';
import { isPutUpAction, type WallControlModel } from './wall-control';
import { windowStartedAnnouncement } from './wall-control-text';

/**
 * What starting a drive did (#7113). `started`: arming, the climb is going up
 * and the connect (if any) is on its way. `held_by_crew`: a crewmate holds the
 * board, so there is no swipe on it by design; nothing changed. `unavailable`: the control offers no swipe here (`swipeAction`).
 */
export type DriveStartOutcome = 'started' | 'held_by_crew' | 'unavailable';

/** What the player runs for each tap action. The handler decides which, from the model. */
export type WallControlRunners = {
  /**
   * Connect, put the preview up, or re-light the climb on screen. False when
   * nothing went up: the busy-wall question took the press instead.
   */
  light: () => boolean;
  /** The bulb's own path: relay to a crewmate, take or release a wall with no lights. */
  toggle: () => void;
  /** Let go of the board, as the board sheet's Disconnect does. */
  disconnect: () => void;
  /** The player's board sheet (Re-light, Turn off all lights, Disconnect). */
  openSheet: () => void;
  /**
   * On the wall per presence with no link (QA #147): connect, then light the
   * climb on screen explicitly, the climber's own climb re-asserted (through
   * the #4979 hold) or a preview put up. Never left to the auto-send. False
   * when nothing went up (the busy-wall question).
   */
  lightAgain: () => boolean;
  /**
   * The climb on screen is on another board at this gym (#7076): move there (a
   * crew session moves too), connect, and light it. A preview is put up first.
   */
  moveToBoard: () => void;
  /**
   * Start driving the wall (#7113): commit the climb on screen without the
   * busy-wall question, connect if needed, light it, and every change of
   * climb lights the wall from then on. `startedBy` is for Drive Mode Ended.
   */
  drive: (startedBy: DriveModeStartedBy) => DriveStartOutcome;
  /**
   * Put on board's climb went up and Stop driving after is a time or Until I
   * stop (2.7): arm the timed drive, or the open-ended one for Until I stop
   * (`startKeepLighting`). It goes live, and the clock starts, at the wall's
   * lit confirm.
   */
  keepLighting: (plan: KeepLightingPlan) => void;
};

export type UseWallControlOptions = {
  analyticsContext?: AnalyticsEventProperties;
  model: WallControlModel;
  runners: WallControlRunners;
  /** For Wall Control Shown: the climb on screen. */
  climbUuid: string | null;
  /** For Wall Control Shown: the player is open. */
  playerOpen: boolean;
  /** For Wall Control Shown: a view of the control that asks is on screen. */
  visible: boolean;
  /** This phone holds the Bluetooth link: a tap-disconnect is announced when it drops. */
  linked: boolean;
  /** For Wall Control Shown and Tapped: why the climb on screen is a preview, or null. */
  previewReason?: WallControlPreviewReason | null;
};

export type WallControlHandlers = {
  press: (control: WallControlSurface) => void;
  longPress: (control: WallControlSurface) => void;
  /**
   * Start driving the wall (#7113): the wall button's "Light every climb"
   * action and the board sheet's row, while the model offers it.
   */
  drive: (control: WallControlSurface) => DriveStartOutcome;
  /**
   * A swipe on the wall button let go past its commit point: start driving,
   * and log Wall Control Swiped (`drive`, or `refused` when nothing started).
   */
  swipe: (control: WallControlSurface) => DriveStartOutcome;
  /** A swipe let go short of its commit point: Wall Control Swiped `cancelled`. */
  swipeCancelled: (control: WallControlSurface) => void;
  /**
   * The busy-wall question's Put mine up: put the climb up, and start the
   * drive the press that raised the question would have (2.7).
   */
  confirmPut: () => void;
  /** The busy-wall question's Keep theirs: the press's drive is dropped. */
  cancelPut: () => void;
};

/**
 * The one handler behind every view of the board control (#7000). A tap runs
 * the model's `tapAction` and logs Wall Control Tapped; a hold opens the board
 * sheet while this phone holds the link and logs Board Controls Opened; Wall
 * Control Shown counts the control that asks. Each fires once, whichever view
 * the climber used.
 *
 * The handlers keep their identity across renders (they read the latest model
 * through a ref), so a memoised bar doesn't re-render for them.
 *
 * Put on board's drive (2.7, Stop driving after): a press that puts the climb
 * up runs the ordinary put-up, and only once it went up arms the drive
 * (`keepLighting`), so the busy-wall question still guards it in a crew. When
 * the question took the press, its Put mine up (`confirmPut`) arms it instead.
 * A timed drive's start, its turn to open-ended and its end are said once each,
 * queued, while the player is open; renewals are silent.
 */
export function useWallControl({
  analyticsContext,
  model,
  runners,
  climbUuid,
  playerOpen,
  visible,
  linked,
  previewReason = null,
}: UseWallControlOptions): WallControlHandlers {
  const { t: tSettings } = useTranslation('settings');
  const { t } = useTranslation('session');
  const stoppedDrivingLabel = t('playView.wallControl.stoppedDriving');
  const latest = useRef({
    model,
    runners,
    stoppedDrivingLabel,
    analyticsContext,
    climbUuid,
    previewReason,
  });
  latest.current = {
    model,
    runners,
    stoppedDrivingLabel,
    analyticsContext,
    climbUuid,
    previewReason,
  };
  // The last tap-disconnect or stop (when, for the double-tap guard), and whether a drop still owes its announcement.
  const guardedTapAtRef = useRef<number | null>(null);
  const announceDropRef = useRef(false);
  // When a timed drive last ran out on its own (the 2 s guard), and whether that end let go of the board.
  const windowEndedAtRef = useRef<number | null>(null);
  const windowEndLetGoRef = useRef(false);
  // A press whose drive waits on the busy-wall question, for the climb it asked about.
  const pendingKeepLightingRef = useRef<{ plan: KeepLightingPlan; climbUuid: string | null } | null>(null);

  useWallControlShown({ state: model.state, climbUuid, playerOpen, visible, previewReason });

  // The question was about the climb on screen: another climb drops the wait.
  useEffect(() => {
    if (pendingKeepLightingRef.current && pendingKeepLightingRef.current.climbUuid !== climbUuid) {
      pendingKeepLightingRef.current = null;
    }
  }, [climbUuid]);

  // A timed drive's start and its end, once each (WCAG 2.2.1: its length and
  // how to keep going, then "Stopped driving the wall"), and a swipe or Light
  // every climb turning it open-ended, which nothing on the wall shows: the lit
  // climb stays lit. Renewals say nothing. Each line is claimed once per drive
  // (`claimDriveAnnouncement`), so a phone split with a player in every tab
  // says it once. The 2 s tap guard is each player's own.
  const lightingMode = useDriveLightingMode();
  const lightingModeRef = useRef(lightingMode);
  // The window this player saw, by its drive's start: its end is said for it.
  // A player mounted mid-window starts with that one.
  const windowStartedAtRef = useRef<number | null>(
    lightingMode === 'window' ? (getDriveMode()?.startedAt ?? null) : null,
  );
  useEffect(() => {
    const previous = lightingModeRef.current;
    lightingModeRef.current = lightingMode;
    if (previous === lightingMode) return;
    const drive = getDriveMode();
    if (lightingMode === 'window') {
      if (!drive || drive.expiresAt === null) return;
      windowStartedAtRef.current = drive.startedAt;
      if (!playerOpen || !claimDriveAnnouncement(drive.startedAt, 'window_started')) return;
      announceQueued(windowStartedAnnouncement(drive.windowMs ?? Math.max(0, drive.expiresAt - Date.now()), t));
      return;
    }
    if (previous !== 'window') return;
    const windowStartedAt = windowStartedAtRef.current;
    windowStartedAtRef.current = null;
    if (lightingMode === 'driving') {
      if (!drive || !playerOpen || !claimDriveAnnouncement(drive.startedAt, 'window_opened_up')) return;
      hapticSuccess();
      announceQueued(t('playView.wallControl.sheetStatusDriving'));
      return;
    }
    if (lightingMode === 'off' && getLastDriveModeExitReason() === 'window_ended') {
      windowEndedAtRef.current = Date.now();
      // With Disconnect Bluetooth when driving ends on, this end lets go of the
      // board too (`DriveModeWatcher`): a screen reader hears it once the link
      // drops, as after a tap that stopped the drive.
      const ended = getLastDriveEnded();
      const letsGo =
        wasLinkedRef.current &&
        ended !== null &&
        shouldDisconnectWhenDrivingEnds(ended, getSetting('disconnectWhenDrivingEnds') === true);
      windowEndLetGoRef.current = letsGo;
      if (letsGo) announceDropRef.current = true;
      if (!playerOpen || windowStartedAt === null || !claimDriveAnnouncement(windowStartedAt, 'window_ended')) return;
      announceQueued(t('playView.wallControl.stoppedDriving'));
    }
  }, [lightingMode, playerOpen, t]);

  // "Board disconnected" when the link actually drops, not at the tap: a
  // disconnect that fails leaves the climber connected and says nothing.
  const wasLinkedRef = useRef(linked);
  useEffect(() => {
    const dropped = wasLinkedRef.current && !linked;
    wasLinkedRef.current = linked;
    if (!dropped || !announceDropRef.current) return;
    announceDropRef.current = false;
    announceQueued(tSettings('ble.barControl.disconnectedLabel'));
  }, [linked, tSettings]);

  const press = useCallback((control: WallControlSurface) => {
    const { model: current, runners: run } = latest.current;
    // A connect in flight: the spinner says so, and a second tap waits.
    if (current.pending) return;
    // The second tap of a double tap on Disconnect board (the link already
    // reads down, but the adapter is still letting go) or on You are driving
    // the wall (it now reads Disconnect board). Drop it.
    const tappedAt = guardedTapAtRef.current;
    if (tappedAt !== null && Date.now() - tappedAt < DISCONNECT_TAP_GUARD_MS) return;
    // Every view runs the one tap (owner, 2026-11-03: "Yes, every bulb"):
    // during a drive the first-row bulb and the MiniPlayer's bulb standing in
    // for it stop driving and keep the link, as the button does.
    const action = current.tapAction;
    // A timed drive just ran out under the climber's thumb: a stop aimed at it
    // now reads Disconnect board, or Put on board once that end let go of the
    // board. Only that is dropped; with the link kept, a Put on board on
    // another climb still goes up.
    const windowEndedAt = windowEndedAtRef.current;
    if (windowEndedAt !== null && Date.now() - windowEndedAt < WINDOW_END_TAP_GRACE_MS) {
      if (action === 'disconnect' || (windowEndLetGoRef.current && isPutUpAction(action))) return;
    }
    trackWallControlTapped({
      state: current.state,
      action,
      control,
      ...(latest.current.previewReason ? { previewReason: latest.current.previewReason } : {}),
      ...(latest.current.analyticsContext ? { analyticsContext: latest.current.analyticsContext } : {}),
    });
    // A fresh press that does something: whatever an earlier one left waiting
    // on the question goes. A noop (a bulb while the question holds the second
    // row) leaves it, so Put mine up still keeps lighting.
    if (action !== 'noop') pendingKeepLightingRef.current = null;
    const putsUp = isPutUpAction(action);
    // The swipe peek's replay: a third Put on board within 5 minutes (spec B3).
    if (putsUp && control === 'button') noteWallPutOnBoardPress();
    // Where Always drive the wall drives, a press drops a stop and its
    // open-ended drive comes back to light the next climbs. Otherwise, with
    // Stop driving after set to a time or Until I stop (2.7), the press puts
    // the climb up the ordinary way and, once it went up, arms the drive.
    if (current.tapDrive === 'resume' && putsUp) clearDrivingStopped();
    const keepLighting =
      putsUp && (current.tapDrive === 'window' || current.tapDrive === 'drive') ? current.tapKeepLighting : null;
    const putUp = (put: () => boolean) => {
      hapticMedium();
      const wentUp = put();
      if (!keepLighting) return;
      if (wentUp) run.keepLighting(keepLighting);
      else pendingKeepLightingRef.current = { plan: keepLighting, climbUuid: latest.current.climbUuid };
    };
    if (current.state === 'on_wall_unlinked' && action !== 'noop') {
      putUp(run.lightAgain);
      return;
    }
    switch (action) {
      case 'disconnect':
        // Letting go of the board is the one tap that ends something, so it
        // buzzes like a warning; a screen reader hears it once the link drops.
        // It frees the board for the next climber, as the board sheet's
        // Disconnect does, and keeps it remembered for 10 minutes so a slip
        // reconnects with one more tap.
        guardedTapAtRef.current = Date.now();
        announceDropRef.current = true;
        hapticWarning();
        run.disconnect();
        return;
      case 'stop_driving':
      case 'stop_window':
        // Stop driving, timed or not, and keep the link: swipes go back to
        // previews. A light buzz, since nothing was let go; the next tap
        // disconnects. With Disconnect Bluetooth when driving ends on, the
        // board is let go too (`DriveModeWatcher`), and said when it drops.
        guardedTapAtRef.current = Date.now();
        if (wasLinkedRef.current && getSetting('disconnectWhenDrivingEnds')) announceDropRef.current = true;
        hapticLight();
        stopDrivingForLink();
        announceQueued(latest.current.stoppedDrivingLabel);
        return;
      case 'connect':
      case 'put_on_wall':
      case 'relight':
        putUp(run.light);
        return;
      case 'relay':
      case 'take_wall':
      case 'release_wall':
        hapticMedium();
        run.toggle();
        return;
      case 'move_to_board':
        hapticMedium();
        run.moveToBoard();
        return;
      case 'noop':
        return;
    }
  }, []);

  const longPress = useCallback((control: WallControlSurface) => {
    const { model: current, runners: run } = latest.current;
    if (current.longPress !== 'sheet') return;
    hapticMedium();
    trackBoardControlsOpened({ surface: 'play_drawer', source: control });
    run.openSheet();
  }, []);

  // The swipe owns its own haptics (the threshold, then an error on a refusal);
  // the lit confirm buzzes success.
  const startDriveBy = useCallback((startedBy: DriveModeStartedBy): DriveStartOutcome => {
    const { model: current, runners: run } = latest.current;
    // `swipeAction` is the one rule for where a drive can start: never while a
    // connect is in flight, the busy-wall question is up, or already driving.
    if (current.swipeAction !== 'drive') return 'unavailable';
    return run.drive(startedBy);
  }, []);
  // The screen-reader action and the board sheet's row.
  const drive = useCallback((_control: WallControlSurface) => startDriveBy('action'), [startDriveBy]);

  // Wall Control Swiped, once per gesture that activated: the state it started
  // in, read before the drive changes it.
  const swipe = useCallback(
    (control: WallControlSurface): DriveStartOutcome => {
      const state = latest.current.model.state;
      const outcome = startDriveBy('swipe');
      trackWallControlSwiped({ state, outcome: outcome === 'started' ? 'drive' : 'refused', control });
      return outcome;
    },
    [startDriveBy],
  );
  const swipeCancelled = useCallback((control: WallControlSurface) => {
    trackWallControlSwiped({ state: latest.current.model.state, outcome: 'cancelled', control });
  }, []);

  // Another climb on screen already dropped the wait (the effect above).
  const confirmPut = useCallback(() => {
    const { runners: run } = latest.current;
    const pending = pendingKeepLightingRef.current;
    pendingKeepLightingRef.current = null;
    const wentUp = run.light();
    if (wentUp && pending) run.keepLighting(pending.plan);
  }, []);
  const cancelPut = useCallback(() => {
    pendingKeepLightingRef.current = null;
  }, []);

  return { press, longPress, drive, swipe, swipeCancelled, confirmPut, cancelPut };
}
