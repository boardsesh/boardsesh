import { useEffect, useRef } from 'react';
import type { BluetoothDisconnectReason } from '../../lib/ble/use-board-bluetooth';
import { useSetting } from '../../settings';
import { getDriveMode, subscribeDriveEnded, type DriveEnded, type DriveModeExitReason } from './drive-mode-store';

/**
 * Disconnect Bluetooth when driving ends (2.7, replacing auto-disconnect): the
 * ends the climber or the clock caused let go of the board, so the next climber
 * can connect. That is a tap on You are driving the wall or Turn off all
 * lights during a drive (`stopped`), and a timed drive running out, its
 * setting turned to Right away, or a crewmate's put-up ending it
 * (`window_ended`).
 *
 * Never the ends that already deal with the link (it dropped, the connect or
 * the first light failed, arming timed out) or that move this phone elsewhere
 * (another session or board, sign-out).
 */
export function shouldDisconnectWhenDrivingEnds(reason: DriveModeExitReason, enabled: boolean): boolean {
  if (!enabled) return false;
  return reason === 'stopped' || reason === 'window_ended';
}

/** This phone's Bluetooth link, as the provider hands it out. */
export type DrivingEndedLink = {
  isConnected: boolean;
  disconnect: (reason?: BluetoothDisconnectReason) => Promise<void>;
};

/**
 * Let go of the board for one drive end, when the setting asks for it. It
 * frees the board without forgetting it (`driving_ended`), so the next Put on
 * board reconnects silently. Where something is still on its way to the wall
 * (`disconnectAfter`), it waits for that first, then lets go only if the link
 * is still up and no new drive took it meanwhile.
 */
export function disconnectForDriveEnd({
  ended,
  enabled,
  readLink,
}: {
  ended: DriveEnded;
  enabled: boolean;
  /** The link as it is now: read again after any wait. */
  readLink: () => DrivingEndedLink | null;
}): void {
  if (!shouldDisconnectWhenDrivingEnds(ended.reason, enabled)) return;
  const letGo = () => {
    const link = readLink();
    if (!link?.isConnected || getDriveMode() !== null) return;
    void link.disconnect('driving_ended');
  };
  if (!ended.disconnectAfter) {
    letGo();
    return;
  }
  ended.disconnectAfter().then(letGo, letGo);
}

/**
 * Wires `disconnectForDriveEnd` to the drive store for this phone's link.
 * Mounted once, in `DriveModeWatcher`, so it holds with the player closed.
 */
export function useDisconnectWhenDrivingEnds(link: DrivingEndedLink | null): void {
  const [enabled] = useSetting('disconnectWhenDrivingEnds');
  const latest = useRef({ link, enabled });
  latest.current = { link, enabled };
  useEffect(
    () =>
      subscribeDriveEnded((ended) => {
        disconnectForDriveEnd({ ended, enabled: latest.current.enabled === true, readLink: () => latest.current.link });
      }),
    [],
  );
}
