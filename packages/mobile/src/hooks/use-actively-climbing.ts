import { useBluetoothConnectedStatus } from '../lib/ble/bluetooth-status-store';
import { useHasWallClimb } from '../components/queue-control/use-wall-or-queue-climb';
import { useQueueSessionId } from '../providers/queue-provider';

/**
 * Single source of truth for "the user is actively climbing right now": a board is
 * connected over Bluetooth, a live wall feed is showing a climb, or a session is in
 * progress. While any of these holds, the active-climb accessory bar asserts itself
 * and cannot be dismissed (the dismiss affordance does not even render), so an
 * active climber can never hide a live control or lose one-tap return / tick.
 *
 * Keep this the ONE definition — it is read by the native mount gate, the JS bar,
 * the dismiss affordances, and the coachmark, so a second copy would drift.
 * All three inputs are cheap presence / rare-change selectors.
 */
export function useIsActivelyClimbing(): boolean {
  const bluetoothConnected = useBluetoothConnectedStatus();
  const hasWallClimb = useHasWallClimb();
  const { sessionId } = useQueueSessionId();
  return bluetoothConnected || hasWallClimb || sessionId !== null;
}
