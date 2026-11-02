import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useWallSwipeToDriveEnabled } from '../../providers/feature-flags-provider';
import { useSetting } from '../../settings';
import {
  DEFAULT_KEEP_LIGHTING,
  DEFAULT_MOONBOARD_KEEP_LIGHTING,
  keepLightingWindowMs,
  lockScreenPressKeepsLighting,
  resolveKeepLightingPlan,
  sanitiseKeepLighting,
} from '../../lib/keep-lighting';
import { useIsCrewSession, useQueueActions, useQueueSessionControls } from '../../providers/queue-provider';
import { addWidgetQueueNavigateListener, isAndroidSessionPresence } from '../../lib/live-activity/live-activity-plugin';
import { adoptLockScreenLighting, armNotificationPressDrive } from './lock-screen-lighting';
import {
  carryDriveIntoCrew,
  clearDrivingStopped,
  isDrivingStoppedForLink,
  DRIVE_ARMING_TIMEOUT_MS,
  exitDriveMode,
  getDriveMode,
  isDriveWindowDue,
  makeDriveOpenEnded,
  markDriveLive,
  resolveDriveModeExit,
  retimeDriveWindow,
  shouldCarryDriveIntoCrew,
  shouldEndWindowForSettings,
  useDriveMode,
  type DriveWatchSnapshot,
} from './drive-mode-store';
import { useDriveCrewPutUp, useDriveWallConfirms } from './use-drive-follow';

/**
 * Ends driving the wall (#7113) when the wall stops being this phone's to
 * drive: the link drops, the swipe's connect fails (or never comes), the
 * session or the board changes, or the climber signs out. It also lets go of
 * a press's "stopped" once that link drops, or once the climber changes Light
 * the board as I swipe (the setting speaks for itself again). Going to the
 * background ends nothing.
 *
 * It also takes an arming drive live once this phone's link lights the climb
 * (here, so closing the player mid-connect still goes live), counts the climbs
 * lit for Drive Mode Ended, and says when a crewmate put a climb up
 * (`use-drive-follow.ts`). And when a crew forms while this climber drives
 * solo by Light the board as I swipe (no stop, a link up), it carries that into
 * the crew as a live drive (`shouldCarryDriveIntoCrew`, #7113 QA).
 *
 * Put on board's keep-lighting window (2.7) ends here too (`window_ended`):
 * one timeout to its end, re-keyed by each climb that renews it, and a
 * catch-up when the app comes back to the foreground, since a timer doesn't
 * run while the app is suspended. Turning its setting off ends it as well, and
 * changing its length mid-window applies to the running window.
 *
 * A Lock Screen or Dynamic Island Next / Previous opens or renews that window
 * natively on iOS, since JS may be suspended when the intent lights the wall
 * (`lock-screen-lighting.ts`). This adopts that write: when the app comes back
 * (before the catch-up, so a renewed window isn't ended as overdue), on the
 * press's own `queueNavigate` event, and when the link comes up. An Android
 * notification Next / Previous writes nothing natively: JS lights the wall for
 * it, so on its `queueNavigate` event this arms a drive the wall's lit confirm
 * takes live, as Put on board does. Either way the drive reports
 * `startedBy: 'lock_screen'`.
 *
 * Renders nothing. Mounted once, in the root layout beside the other
 * app-wide syncs, so a drive ends the same way with the player closed.
 */
export function DriveModeWatcher(): null {
  const bluetooth = useOptionalBluetoothContext();
  const linked = (bluetooth?.isConnected ?? false) || (bluetooth?.virtualWallHeld ?? false);
  const pending = bluetooth?.loading ?? false;
  const { sessionId } = useQueueSessionControls();
  const { boardId } = useBoardPresenceControls();
  const { isAuthenticated } = useAuth();
  const drive = useDriveMode();
  // Goes live, and counts the climbs lit, at this phone's own link's confirms.
  useDriveWallConfirms(bluetooth?.isConnected ?? false);
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const lightOnSwipeRef = useRef(lightOnSwipe);
  // The roster's crew, after its arrival dwell: until it forms, the climber is solo.
  const isCrewSession = useIsCrewSession();
  const wasCrewRef = useRef(isCrewSession);
  const previousRef = useRef<DriveWatchSnapshot | null>(null);
  // The arming drive (by its start) whose connect was seen in flight.
  const connectSeenForRef = useRef<number | null>(null);

  // Settings › Board's keep-lighting (2.7): the window-end rule below, and what
  // an Android notification press keeps lighting.
  const [storedKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const [storedMoonboardKeepLighting] = useSetting('moonboardPutOnBoardKeepsLighting');
  const [drivesInSession] = useSetting('putOnBoardDrivesInSession');
  const keepLighting = sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING);
  const moonboardKeepLighting = sanitiseKeepLighting(storedMoonboardKeepLighting, DEFAULT_MOONBOARD_KEEP_LIGHTING);
  const swipeToDriveEnabled = useWallSwipeToDriveEnabled();
  const { getQueueSnapshot } = useQueueActions();

  // A lock-screen press's window, adopted (iOS) or armed (Android) with the
  // latest reads. Stable, so the listeners below subscribe once and the
  // window-end check can call it first.
  const boardType = bluetooth?.boardName ?? null;
  const pressPlan = lockScreenPressKeepsLighting({ swipeToDriveEnabled, lightOnSwipe, inSession: isCrewSession })
    ? resolveKeepLightingPlan({
        boardIsMoonboard: isMoonboardBoardName(boardType),
        keepLighting,
        moonboardKeepLighting,
        drivesInSession,
        inSession: isCrewSession,
      })
    : null;
  const adoptionInputRef = useRef({ sessionId, linked, boardId, boardType, plan: pressPlan });
  adoptionInputRef.current = { sessionId, linked, boardId, boardType, plan: pressPlan };
  const adoptFromLockScreen = useCallback(() => {
    adoptLockScreenLighting(adoptionInputRef.current);
  }, []);
  // A crewmate's put-up ends a window a Lock Screen press opened too: adopted
  // first, so it ends now instead of coming back at the next adoption.
  useDriveCrewPutUp(drive?.phase ?? null, adoptFromLockScreen);
  useEffect(() => {
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') adoptFromLockScreen();
    });
    const removeNavigateListener = addWidgetQueueNavigateListener((event) => {
      adoptFromLockScreen();
      if (!isAndroidSessionPresence) return;
      // The bridge drops a press whose index the queue doesn't hold; nothing lights then.
      const { queue } = getQueueSnapshot();
      if (event.currentIndex < 0 || event.currentIndex >= queue.length) return;
      armNotificationPressDrive(adoptionInputRef.current);
    });
    return () => {
      appState.remove();
      removeNavigateListener();
    };
  }, [adoptFromLockScreen, getQueueSnapshot]);
  // On mount, and whenever the link or the session changes: a write left while
  // the link was down can be judged now. One from before this JS started (a
  // press before a kill or a reload) never is: a relaunch starts with nobody
  // driving.
  useEffect(() => {
    adoptFromLockScreen();
  }, [adoptFromLockScreen, linked, sessionId]);

  useEffect(() => {
    const current: DriveWatchSnapshot = { linked, pending, sessionId, boardId, signedIn: isAuthenticated };
    const previous = previousRef.current ?? current;
    previousRef.current = current;
    if ((previous.linked && !current.linked) || (previous.signedIn && !current.signedIn)) clearDrivingStopped();
    if (!drive) return;
    if (drive.phase === 'arming' && current.pending) connectSeenForRef.current = drive.startedAt;
    const reason = resolveDriveModeExit({
      drive,
      previous,
      current,
      connectSeen: connectSeenForRef.current === drive.startedAt,
    });
    if (reason) {
      exitDriveMode(reason);
      return;
    }
    // The player starts a drive without knowing the bound board: learn it once
    // live, so a later change of board ends the drive.
    if (drive.phase === 'live' && drive.boardId === null && current.boardId !== null) {
      markDriveLive({ boardId: current.boardId });
    }
  }, [linked, pending, sessionId, boardId, isAuthenticated, drive]);

  // A crew formed while this climber drove solo by Light the board as I swipe:
  // keep driving, as a live drive (#7113 QA, Marco). A live drive already goes on.
  useEffect(() => {
    const crewFormed = isCrewSession && !wasCrewRef.current;
    wasCrewRef.current = isCrewSession;
    if (
      shouldCarryDriveIntoCrew({
        crewFormed,
        drive: getDriveMode(),
        linked,
        stopped: isDrivingStoppedForLink(),
        lightOnSwipe,
      })
    ) {
      carryDriveIntoCrew({ sessionId, boardId, boardType: bluetooth?.boardName ?? null });
    }
  }, [isCrewSession, linked, lightOnSwipe, sessionId, boardId, bluetooth?.boardName]);

  useEffect(() => {
    if (lightOnSwipeRef.current === lightOnSwipe) return;
    lightOnSwipeRef.current = lightOnSwipe;
    clearDrivingStopped();
  }, [lightOnSwipe]);

  // Settings › Board changed under a keep-lighting window: its choice turned
  // Off, or In a session too turned off in a crew. The window ends. "A crew"
  // is the roster's `isCrewSession`, the read the press's own `crewSession`
  // takes in PlayCore, so both agree on what a session is.
  //
  // Its own choice moved to another length (the board sheet's row, at the
  // wall, spec B4): the running window takes it, counted from now, and Until I
  // stop makes it open-ended. Only a change does: a window opened from a plan
  // (or adopted from the Lock Screen) keeps its length until its choice moves.
  // The settings are read above, with what a lock-screen press keeps lighting.
  const choicesRef = useRef({ keepLighting, moonboardKeepLighting });
  const windowed = drive?.windowMs != null;
  useEffect(() => {
    const previous = choicesRef.current;
    choicesRef.current = { keepLighting, moonboardKeepLighting };
    if (!windowed) return;
    const latest = getDriveMode();
    if (
      shouldEndWindowForSettings({
        drive: latest,
        keepLighting,
        moonboardKeepLighting,
        drivesInSession,
        inSession: isCrewSession,
      })
    ) {
      exitDriveMode('window_ended');
      return;
    }
    const moonboardWindow = latest?.windowSetting === 'moonboardPutOnBoardKeepsLighting';
    const choice = moonboardWindow ? moonboardKeepLighting : keepLighting;
    if (choice === (moonboardWindow ? previous.moonboardKeepLighting : previous.keepLighting)) return;
    const windowMs = keepLightingWindowMs(choice);
    if (windowMs === null) makeDriveOpenEnded();
    else if (windowMs !== undefined) retimeDriveWindow(windowMs);
  }, [windowed, keepLighting, moonboardKeepLighting, drivesInSession, isCrewSession]);

  // The window's end, modelled on the arming timeout below: one timeout, keyed
  // on the end, so a renewal re-arms it. A timer that fires a beat early (or a
  // clock that moved) waits out the rest instead of letting the window run on.
  const windowEndsAt = drive?.phase === 'live' ? drive.expiresAt : null;
  useEffect(() => {
    if (windowEndsAt === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const endIfDue = () => {
      // A lock-screen press may have renewed it while JS was suspended.
      adoptFromLockScreen();
      const latest = getDriveMode();
      if (latest?.expiresAt !== windowEndsAt) return;
      if (isDriveWindowDue(latest)) {
        exitDriveMode('window_ended');
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(endIfDue, Math.max(0, windowEndsAt - Date.now()));
    };
    timer = setTimeout(endIfDue, Math.max(0, windowEndsAt - Date.now()));
    // A suspended app runs no timers: catch up the moment it is back.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') endIfDue();
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      subscription.remove();
    };
  }, [windowEndsAt, adoptFromLockScreen]);

  // A connect in flight holds the arming clock: the device picker stays open
  // while the climber reads the list, as long as they need (the tap's own
  // relight waits on it too). The clock starts again when the connect settles;
  // one that settled with no link is `connect_failed` above.
  const armingSince = drive?.phase === 'arming' ? drive.startedAt : null;
  useEffect(() => {
    if (armingSince === null || pending) return undefined;
    const timer = setTimeout(() => {
      const latest = getDriveMode();
      if (latest?.phase === 'arming' && latest.startedAt === armingSince) exitDriveMode('arming_timed_out');
    }, DRIVE_ARMING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armingSince, pending]);

  return null;
}
