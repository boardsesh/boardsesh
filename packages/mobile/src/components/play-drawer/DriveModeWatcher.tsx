import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useSetting } from '../../settings';
import { DEFAULT_KEEP_LIGHTING, DEFAULT_MOONBOARD_KEEP_LIGHTING, sanitiseKeepLighting } from '../../lib/keep-lighting';
import { useIsCrewSession, useQueueSessionControls } from '../../providers/queue-provider';
import {
  carryDriveIntoCrew,
  clearDrivingStopped,
  isDrivingStoppedForLink,
  DRIVE_ARMING_TIMEOUT_MS,
  exitDriveMode,
  getDriveMode,
  isDriveWindowDue,
  markDriveLive,
  resolveDriveModeExit,
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
 * run while the app is suspended. Turning its setting off ends it as well.
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
  useDriveCrewPutUp(drive?.phase ?? null);
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
      carryDriveIntoCrew({ sessionId, boardId });
    }
  }, [isCrewSession, linked, lightOnSwipe, sessionId, boardId]);

  useEffect(() => {
    if (lightOnSwipeRef.current === lightOnSwipe) return;
    lightOnSwipeRef.current = lightOnSwipe;
    clearDrivingStopped();
  }, [lightOnSwipe]);

  // Settings › Board changed under a keep-lighting window: its choice turned
  // Off, or In a session too turned off in a crew. The window ends.
  const [storedKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const [storedMoonboardKeepLighting] = useSetting('moonboardPutOnBoardKeepsLighting');
  const [drivesInSession] = useSetting('putOnBoardDrivesInSession');
  const keepLighting = sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING);
  const moonboardKeepLighting = sanitiseKeepLighting(storedMoonboardKeepLighting, DEFAULT_MOONBOARD_KEEP_LIGHTING);
  const windowed = drive?.windowMs != null;
  useEffect(() => {
    if (!windowed) return;
    if (
      shouldEndWindowForSettings({
        drive: getDriveMode(),
        keepLighting,
        moonboardKeepLighting,
        drivesInSession,
        inSession: isCrewSession,
      })
    ) {
      exitDriveMode('window_ended');
    }
  }, [windowed, keepLighting, moonboardKeepLighting, drivesInSession, isCrewSession]);

  // The window's end, modelled on the arming timeout below: one timeout, keyed
  // on the end, so a renewal re-arms it. A timer that fires a beat early (or a
  // clock that moved) waits out the rest instead of letting the window run on.
  const windowEndsAt = drive?.phase === 'live' ? drive.expiresAt : null;
  useEffect(() => {
    if (windowEndsAt === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const endIfDue = () => {
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
  }, [windowEndsAt]);

  const armingSince = drive?.phase === 'arming' ? drive.startedAt : null;
  useEffect(() => {
    if (armingSince === null) return undefined;
    const timer = setTimeout(
      () => {
        const latest = getDriveMode();
        if (latest?.phase === 'arming' && latest.startedAt === armingSince) exitDriveMode('arming_timed_out');
      },
      Math.max(0, armingSince + DRIVE_ARMING_TIMEOUT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [armingSince]);

  return null;
}
