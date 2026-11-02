import { useEffect, useRef } from 'react';
import type { BluetoothDisconnectReason } from '../../lib/ble/use-board-bluetooth';
import type { BleWriteActivityStore } from '../../lib/ble/write-activity-store';
import { useBluetoothWriteActivityStore } from '../../providers/bluetooth-write-activity';
import { useSetting } from '../../settings';
import { getDriveMode, subscribeDriveEnded, type DriveEnded } from './drive-mode-store';

/**
 * Disconnect Bluetooth when driving ends (2.7, replacing auto-disconnect): the
 * ends the climber or the clock caused let go of the board, so the next climber
 * can connect. That is a tap on You are driving the wall or Turn off all
 * lights during a drive (`stopped`), and a timed drive running out or a
 * crewmate's put-up ending it (`window_ended`).
 *
 * Never the ends that already deal with the link (it dropped, the connect or
 * the first light failed, arming timed out), that move this phone elsewhere
 * (another session or board, sign-out), or that Settings › Board caused
 * (`keepLink`: Right away picked mid-drive, or In a session too off as a crew
 * formed), nor a timed drive a lock-screen press found over while it lights a
 * climb of its own (`keepLink` too, `lock-screen-lighting.ts`).
 */
export function shouldDisconnectWhenDrivingEnds(
  ended: Pick<DriveEnded, 'reason' | 'keepLink'>,
  enabled: boolean,
): boolean {
  if (!enabled || ended.keepLink) return false;
  return ended.reason === 'stopped' || ended.reason === 'window_ended';
}

/**
 * The longest letting go waits for a write already on its way to the wall: a
 * climb picked in a timed drive's last moments, or Turn off all lights.
 */
export const DRIVE_END_WRITE_WAIT_MS = 5_000;

/** This phone's Bluetooth link, as the provider hands it out. */
export type DrivingEndedLink = {
  isConnected: boolean;
  disconnect: (reason?: BluetoothDisconnectReason) => Promise<void>;
};

/**
 * Run `then` once no write is in flight on this phone's link, or after
 * `DRIVE_END_WRITE_WAIT_MS`. At once when nothing is writing.
 */
function afterWritesSettle(writeActivity: BleWriteActivityStore | null, then: () => void): void {
  if (!writeActivity?.getSnapshot()) {
    then();
    return;
  }
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe?.();
    then();
  };
  unsubscribe = writeActivity.subscribe(() => {
    if (!writeActivity.getSnapshot()) finish();
  });
  timer = setTimeout(finish, DRIVE_END_WRITE_WAIT_MS);
}

/**
 * Let go of the board for one drive end, when the setting asks for it. It
 * frees the board without forgetting it (`driving_ended`), so the next Put on
 * board reconnects silently. Where something is still on its way to the wall
 * (`disconnectAfter`, then any write in flight: a pick in the drive's last
 * moments), it waits for that first, then lets go only if the link is still
 * up and no new drive took it meanwhile.
 */
export function disconnectForDriveEnd({
  ended,
  enabled,
  readLink,
  writeActivity = null,
}: {
  ended: DriveEnded;
  enabled: boolean;
  /** The link as it is now: read again after any wait. */
  readLink: () => DrivingEndedLink | null;
  /** This phone's write activity, so a write in flight lands before the link goes. */
  writeActivity?: BleWriteActivityStore | null;
}): void {
  if (!shouldDisconnectWhenDrivingEnds(ended, enabled)) return;
  const letGo = () => {
    const link = readLink();
    if (!link?.isConnected || getDriveMode() !== null) return;
    void link.disconnect('driving_ended');
  };
  const settleThenLetGo = () => afterWritesSettle(writeActivity, letGo);
  if (!ended.disconnectAfter) {
    settleThenLetGo();
    return;
  }
  ended.disconnectAfter().then(settleThenLetGo, settleThenLetGo);
}

/**
 * Wires `disconnectForDriveEnd` to the drive store for this phone's link.
 * Mounted once, in `DriveModeWatcher`, so it holds with the player closed.
 */
export function useDisconnectWhenDrivingEnds(link: DrivingEndedLink | null): void {
  const [enabled] = useSetting('disconnectWhenDrivingEnds');
  const writeActivity = useBluetoothWriteActivityStore();
  const latest = useRef({ link, enabled, writeActivity });
  latest.current = { link, enabled, writeActivity };
  useEffect(
    () =>
      subscribeDriveEnded((ended) => {
        disconnectForDriveEnd({
          ended,
          enabled: latest.current.enabled === true,
          readLink: () => latest.current.link,
          writeActivity: latest.current.writeActivity,
        });
      }),
    [],
  );
}
