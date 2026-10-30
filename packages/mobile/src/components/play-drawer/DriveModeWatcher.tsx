import { useContext, useEffect, useRef } from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useSetting } from '../../settings';
import { useQueueSessionControls } from '../../providers/queue-provider';
import {
  clearDrivingStopped,
  DRIVE_ARMING_TIMEOUT_MS,
  DRIVE_HANDOFF_ARMING_TIMEOUT_MS,
  exitDriveMode,
  getDriveMode,
  markDriveLive,
  resolveDriveModeExit,
  useDriveMode,
  type DriveWatchSnapshot,
} from './drive-mode-store';
import { useDriveCrewPutUp, useDriveWallConfirms } from './use-drive-follow';
import { cancelBoardReleaseWait, noteBoardHolder } from './board-handoff-store';

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
 * (`use-drive-follow.ts`). While a swipe waits for a crewmate's phone to let
 * go of the board (#7113), it feeds that wait presence's holder, and stops it
 * when the drive ends.
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
  const previousRef = useRef<DriveWatchSnapshot | null>(null);
  // Raw context: the watcher mounts at the app root, outside a board's feed in tests.
  const presence = useContext(BoardPresenceCurrentContext);
  const presenceHolder = presence?.holder ?? null;
  const presenceConnectionSeq = presence?.lastConnectionSeq ?? 0;
  useEffect(() => {
    noteBoardHolder({ holder: presenceHolder, connectionSeq: presenceConnectionSeq });
  }, [presenceHolder, presenceConnectionSeq]);
  useEffect(() => {
    if (!drive) cancelBoardReleaseWait();
  }, [drive]);
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

  useEffect(() => {
    if (lightOnSwipeRef.current === lightOnSwipe) return;
    lightOnSwipeRef.current = lightOnSwipe;
    clearDrivingStopped();
  }, [lightOnSwipe]);

  const armingSince = drive?.phase === 'arming' ? drive.startedAt : null;
  const armingTimeoutMs = drive?.handoff ? DRIVE_HANDOFF_ARMING_TIMEOUT_MS : DRIVE_ARMING_TIMEOUT_MS;
  useEffect(() => {
    if (armingSince === null) return undefined;
    const timer = setTimeout(
      () => {
        const latest = getDriveMode();
        if (latest?.phase === 'arming' && latest.startedAt === armingSince) exitDriveMode('arming_timed_out');
      },
      Math.max(0, armingSince + armingTimeoutMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [armingSince, armingTimeoutMs]);

  return null;
}
