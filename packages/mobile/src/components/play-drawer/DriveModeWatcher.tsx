import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useWallSwipeToDriveEnabled } from '../../providers/feature-flags-provider';
import { useSetting } from '../../settings';
import {
  DEFAULT_KEEP_LIGHTING,
  alwaysDriveApplies,
  keepLightingWindowMs,
  lockScreenPressKeepsLighting,
  resolveKeepLightingPlan,
  sanitiseKeepLighting,
} from '../../lib/keep-lighting';
import { useIsCrewSession, useQueueActions, useQueueSessionControls } from '../../providers/queue-provider';
import {
  addLockScreenDriveStopListener,
  addWidgetQueueNavigateListener,
  isAndroidSessionPresence,
} from '../../lib/live-activity/live-activity-plugin';
import {
  adoptLockScreenLighting,
  armNotificationPressDrive,
  endTimedDriveAtClock,
  endTimedDriveOverAtPress,
} from './lock-screen-lighting';
import {
  clearDrivingStopped,
  isDrivingStoppedForLink,
  DRIVE_ARMING_TIMEOUT_MS,
  exitDriveMode,
  getDriveMode,
  isAlwaysDriveOwned,
  isDriveWindowDue,
  makeDriveOpenEnded,
  markDriveLive,
  resolveDriveModeExit,
  retimeDriveWindow,
  shouldEndWindowForSettings,
  shouldStartAlwaysDrive,
  startAlwaysDrive,
  useDriveMode,
  useDrivingStoppedForLink,
  type DriveWatchSnapshot,
} from './drive-mode-store';
import { useBoardLetsGo } from './use-board-lets-go';
import { useSprayWallLedsEnabled } from '../../lib/spray/use-spray-wall-leds-enabled';
import { useDriveCrewPutUp, useDriveWallConfirms } from './use-drive-follow';
import { useDisconnectWhenDrivingEnds } from './use-driving-ended-disconnect';

/**
 * Ends driving the wall (#7113) when the wall stops being this phone's to
 * drive: the link drops, the swipe's connect fails (or never comes), the
 * session or the board changes, or the climber signs out. It also lets go of
 * a press's "stopped" once that link drops. Going to the background ends
 * nothing.
 *
 * It also takes an arming drive live once this phone's link lights the climb
 * (here, so closing the player mid-connect still goes live), counts the climbs
 * lit for Drive Mode Ended, and says when a crewmate put a climb up
 * (`use-drive-follow.ts`).
 *
 * Always drive the wall (Settings › Board, `alwaysDrive`) drives from here: while
 * it applies (`alwaysDriveApplies`: in a crew only with In a session too on,
 * on every board, and never with the `wall-swipe-to-drive` flag off,
 * driving's kill switch) and this phone's own Bluetooth link holds the board,
 * an open-ended drive is on (`startAlwaysDrive`), started live when the link
 * comes up, when the switch turns on, or when a drive ends with the link still
 * up. It lights nothing as it starts. A stop on this link holds it off until
 * the link drops or the next Put on board (`tapDrive: 'resume'`), or until the
 * climber flips the switch (it speaks for itself again). Where it
 * stops applying (the switch off, a crew forming where In a session too is
 * off, or the flag off) its drive ends keeping the link (`always_off`), and so
 * does a timed drive it opened up when it turned on (`openedByAlways`). A
 * drive another way started (a swipe, Light every climb) is left as it is.
 *
 * Put on board's timed drive (2.7, Stop driving after) ends here too
 * (`window_ended`): one timeout to its end, re-keyed by each climb that renews
 * it, and a catch-up when the app comes back to the foreground, since a timer
 * doesn't run while the app is suspended. Turning its setting to Right away
 * ends it as well (keeping the link), and changing its length mid-drive
 * applies to the running one.
 *
 * And with Disconnect Bluetooth when driving ends on, the ends the climber or
 * the clock caused let go of the board (`use-driving-ended-disconnect.ts`).
 *
 * A link that drops on its own mid-drive, or that another phone takes, is
 * said once: a warning buzz, a screen-reader line and the player's top-bar
 * caption, naming who took the board when presence knows
 * (`use-board-lets-go.ts`). A hang-up or a board switch mid-drive ends it the
 * same way and says nothing.
 *
 * A Lock Screen or Dynamic Island Next / Previous starts or renews that drive
 * natively on iOS, since JS may be suspended when the intent lights the wall
 * (`lock-screen-lighting.ts`). This adopts that write: when the app comes back
 * (before the catch-up, so a renewed timed drive isn't ended as overdue), on
 * the press's own `queueNavigate` event, and when the link comes up. An
 * Android notification Next / Previous writes nothing natively: JS lights the
 * wall for it, so on its `queueNavigate` event this arms a drive the wall's
 * lit confirm takes live, as Put on board does. Either way the drive reports
 * `startedBy: 'lock_screen'`. Under Right away a press lights its one climb
 * and starts no drive. The iOS Lock Screen bulb stops a drive the same way:
 * native stores the stop, and this adopts it on `lockScreenDriveStop` or when
 * the app comes back (`stopped`, so Disconnect Bluetooth when driving ends
 * applies as for the frosted button). On both platforms a press that finds a timed drive over
 * ends it keeping the board (`endTimedDriveOverAtPress`); the catch-up with no
 * press heard ends it at the clock, letting go when the setting says so. On
 * iOS JS hears a press only after its board write, so the catch-up (and the
 * timer) first reads the intent's press stamp (`endTimedDriveAtClock`): a
 * press still on its way to the wall holds the end until it settles or its
 * stamp runs out, and one that landed after the end ends it keeping the board.
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
  // Ends a drive whose link dropped, and says so when this phone didn't drop it.
  const endDriveForLinkDrop = useBoardLetsGo({ linked, pending, boardId, drive, signedIn: isAuthenticated });
  // A spray wall's LED hold is this phone's own link, as a radio is on other boards.
  const sprayLedsEnabled = useSprayWallLedsEnabled(bluetooth?.boardName, bluetooth?.layoutId);
  const ownLink = (bluetooth?.isConnected ?? false) || (sprayLedsEnabled && (bluetooth?.virtualWallHeld ?? false));
  // Goes live, and counts the climbs lit, at this phone's own link's confirms.
  useDriveWallConfirms(ownLink);
  useDisconnectWhenDrivingEnds(bluetooth);
  // The roster's crew, after its arrival dwell: until it forms, the climber is solo.
  const isCrewSession = useIsCrewSession();
  const drivingStopped = useDrivingStoppedForLink();
  const previousRef = useRef<DriveWatchSnapshot | null>(null);
  // The arming drive (by its start) whose connect was seen in flight.
  const connectSeenForRef = useRef<number | null>(null);

  // Settings › Board's Stop driving after (2.7): the timed-drive end rule
  // below, and the drive an Android notification press starts.
  const [storedKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const [drivesInSession] = useSetting('putOnBoardDrivesInSession');
  const keepLighting = sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING);
  const swipeToDriveEnabled = useWallSwipeToDriveEnabled();
  const { getQueueSnapshot } = useQueueActions();
  const boardType = bluetooth?.boardName ?? null;
  // Always drive the wall: whether it drives on this board and in this session.
  const [alwaysDrive] = useSetting('alwaysDrive');
  const alwaysApplies = alwaysDriveApplies({
    alwaysDrive,
    swipeToDriveEnabled,
    drivesInSession,
    inSession: isCrewSession,
  });

  // A lock-screen press's drive, adopted (iOS) or armed (Android) with the
  // latest reads. Stable, so the listeners below subscribe once and the
  // timed-drive end check can call it first. Where Always drive the wall drives,
  // a press lights its climb and starts nothing: every pick lights already.
  const pressPlan = lockScreenPressKeepsLighting({ swipeToDriveEnabled, alwaysDrive: alwaysApplies })
    ? resolveKeepLightingPlan({
        keepLighting,
        drivesInSession,
        inSession: isCrewSession,
      })
    : null;
  const adoptionInputRef = useRef({ sessionId, linked, boardId, boardType, plan: pressPlan });
  adoptionInputRef.current = { sessionId, linked, boardId, boardType, plan: pressPlan };
  const adoptFromLockScreen = useCallback(() => {
    adoptLockScreenLighting(adoptionInputRef.current);
  }, []);
  // A crewmate's put-up ends a timed drive a Lock Screen press started too: adopted
  // first, so it ends now instead of coming back at the next adoption.
  useDriveCrewPutUp(drive?.phase ?? null, adoptFromLockScreen);
  useEffect(() => {
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') adoptFromLockScreen();
    });
    const removeNavigateListener = addWidgetQueueNavigateListener((event) => {
      adoptFromLockScreen();
      if (!isAndroidSessionPresence) {
        // iOS: the intent lit the wall and wrote the press's own drive, adopted
        // just above, unless Right away starts none. A timed drive still over
        // then has nothing to replace it: it ends keeping the board, as
        // Android's press does below.
        endTimedDriveOverAtPress();
        return;
      }
      // The bridge drops a press whose index the queue doesn't hold; nothing lights then.
      const { queue } = getQueueSnapshot();
      if (event.currentIndex < 0 || event.currentIndex >= queue.length) return;
      armNotificationPressDrive(adoptionInputRef.current);
    });
    // iOS: the Lock Screen bulb stopped the drive while this JS runs. A stop
    // while it was suspended is adopted when the app comes back, above.
    const removeStopListener = addLockScreenDriveStopListener(adoptFromLockScreen);
    return () => {
      appState.remove();
      removeNavigateListener();
      removeStopListener();
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
      if (reason === 'link_dropped') endDriveForLinkDrop();
      else exitDriveMode(reason);
      return;
    }
    // The player starts a drive without knowing the bound board: learn it once
    // live, so a later change of board ends the drive.
    if (drive.phase === 'live' && drive.boardId === null && current.boardId !== null) {
      markDriveLive({ boardId: current.boardId });
    }
  }, [linked, pending, sessionId, boardId, isAuthenticated, drive, endDriveForLinkDrop]);

  // Always drive the wall. Where it no longer applies (the switch off, a crew
  // formed with In a session too off, or the swipe flag off) its own drive
  // ends, and so does a timed drive it opened up; the link stays: a settings
  // change or a crewmate joining never frees the board. Where it applies, a
  // timed drive already running goes on with no end, as a swipe would make
  // it; and with this phone's own link up, nothing driving and no stop on this
  // link, its drive starts: at the link coming up, the switch turning on, a
  // stop let go (the link dropped, or Put on board resumed it), or any other
  // drive ending with the link still up. Read live from the store, so a drive
  // ended earlier in this commit counts as gone.
  //
  // That last one includes the exits above that keep the link: a change of
  // session or board, or a sign-out (signing out drops no link, and Light
  // automatically drives signed out too, as the two switches it replaced
  // lit). Each ends one drive and starts the next at once, so Drive Mode
  // Ended / Started pair up per session, board and account, by design.
  const driveActive = drive !== null;
  const windowed = drive?.windowMs != null;
  // Flipping the switch is a fresh choice: a stop made before it no longer holds.
  const alwaysDriveRef = useRef(alwaysDrive);
  useEffect(() => {
    if (alwaysDriveRef.current === alwaysDrive) return;
    alwaysDriveRef.current = alwaysDrive;
    clearDrivingStopped();
  }, [alwaysDrive]);
  useEffect(() => {
    const latest = getDriveMode();
    if (!alwaysApplies) {
      // Its own drive, or a timed drive it opened up: the climber's window is
      // gone, so it ends rather than running on with no end.
      if (isAlwaysDriveOwned(latest)) exitDriveMode('always_off', { keepLink: true });
      return;
    }
    if (latest?.windowMs != null) {
      makeDriveOpenEnded({ byAlways: true });
      return;
    }
    if (!shouldStartAlwaysDrive({ applies: true, ownLink, drive: latest, stopped: isDrivingStoppedForLink() })) return;
    startAlwaysDrive({ sessionId, boardId, boardType });
  }, [alwaysApplies, ownLink, driveActive, windowed, drivingStopped, sessionId, boardId, boardType]);

  // Settings › Board changed under a timed drive: its choice turned to Right
  // away, or In a session too turned off in a crew (or a crew formed with it
  // off). The drive ends, and the link stays (`keepLink`): Disconnect
  // Bluetooth when driving ends is for the ends the climber made at the wall
  // or the clock made, never a settings change or a crewmate joining. "A crew"
  // is the roster's `isCrewSession`, the read the press's own `crewSession`
  // takes in PlayCore, so both agree on what a session is.
  //
  // Its own choice moved to another length (the board sheet's row, at the
  // wall, spec B4): the running drive takes it, counted from now, and Until I
  // stop makes it open-ended. Only a change does: a drive started from a plan
  // (or adopted from the Lock Screen) keeps its length until its choice moves.
  // The settings are read above, with what a lock-screen press keeps lighting.
  const previousKeepLightingRef = useRef(keepLighting);
  useEffect(() => {
    const previousKeepLighting = previousKeepLightingRef.current;
    previousKeepLightingRef.current = keepLighting;
    if (!windowed) return;
    const latest = getDriveMode();
    if (
      shouldEndWindowForSettings({
        drive: latest,
        keepLighting,
        drivesInSession,
        inSession: isCrewSession,
      })
    ) {
      exitDriveMode('window_ended', { keepLink: true });
      return;
    }
    if (keepLighting === previousKeepLighting) return;
    const windowMs = keepLightingWindowMs(keepLighting);
    if (windowMs === null) makeDriveOpenEnded();
    else if (windowMs !== undefined) retimeDriveWindow(windowMs);
  }, [windowed, keepLighting, drivesInSession, isCrewSession]);

  // The timed drive's end, modelled on the arming timeout below: one timeout, keyed
  // on the end, so a renewal re-arms it. A timer that fires a beat early (or a
  // clock that moved) waits out the rest instead of letting the window run on.
  // An iOS Lock Screen press still on its way to the wall holds the end: it
  // looks again shortly, until the press settles or its stamp runs out.
  const windowEndsAt = drive?.phase === 'live' ? drive.expiresAt : null;
  useEffect(() => {
    if (windowEndsAt === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const endIfDue = () => {
      // A lock-screen press may have renewed it while JS was suspended.
      adoptFromLockScreen();
      const latest = getDriveMode();
      if (latest?.expiresAt !== windowEndsAt) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (isDriveWindowDue(latest)) {
        const recheckInMs = endTimedDriveAtClock();
        if (recheckInMs !== null) timer = setTimeout(endIfDue, recheckInMs);
        return;
      }
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
