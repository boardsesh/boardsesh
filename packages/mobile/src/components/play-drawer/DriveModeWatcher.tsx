import { useEffect, useRef } from 'react';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useSetting } from '../../settings';
import { useIsCrewSession, useQueueSessionControls } from '../../providers/queue-provider';
import {
  carryDriveIntoCrew,
  clearDrivingStopped,
  isDrivingStoppedForLink,
  DRIVE_ARMING_TIMEOUT_MS,
  exitDriveMode,
  getDriveMode,
  markDriveLive,
  resolveDriveModeExit,
  shouldCarryDriveIntoCrew,
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
