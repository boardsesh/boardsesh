import { useEffect, useRef } from 'react';
import { useAuth } from '../../providers/auth-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useSetting } from '../../settings';
import { useQueueSessionControls } from '../../providers/queue-provider';
import {
  clearDrivingStopped,
  DRIVE_ARMING_TIMEOUT_MS,
  exitDriveMode,
  getDriveMode,
  resolveDriveModeExit,
  useDriveMode,
  type DriveWatchSnapshot,
} from './drive-mode-store';

/**
 * Ends driving the wall (#7113) when the wall stops being this phone's to
 * drive: the link drops, the swipe's connect fails (or never comes), the
 * session or the board changes, or the climber signs out. It also lets go of
 * a press's "stopped" once that link drops, or once the climber changes Light
 * the board as I swipe (the setting speaks for itself again). Going to the
 * background ends nothing.
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
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const lightOnSwipeRef = useRef(lightOnSwipe);
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
    if (reason) exitDriveMode(reason);
  }, [linked, pending, sessionId, boardId, isAuthenticated, drive]);

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
