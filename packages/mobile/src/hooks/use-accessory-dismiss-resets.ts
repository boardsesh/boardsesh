import { useEffect, useRef } from 'react';
import { useBluetoothConnectedStatus } from '../lib/ble/bluetooth-status-store';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { resetAccessoryDismiss } from '../lib/accessory-dismiss-store';

/**
 * Brings a tucked-away accessory bar back when the user CONNECTS to a board (BLE
 * goes disconnected → connected) or SWITCHES the active board. The dismissed state
 * otherwise survives app launches (it is keyed to the climb and persisted), so
 * these board events are the explicit "I'm at the wall now" signals that clear it.
 *
 * Mount once near the app root (see {@link import('../components/queue-control/AccessoryDismissResets')}).
 */
export function useAccessoryDismissResets(): void {
  const bluetoothConnected = useBluetoothConnectedStatus();
  const { data: activeBoard } = useActiveBoard();

  const prevConnectedRef = useRef(bluetoothConnected);
  useEffect(() => {
    if (bluetoothConnected && !prevConnectedRef.current) resetAccessoryDismiss();
    prevConnectedRef.current = bluetoothConnected;
  }, [bluetoothConnected]);

  // `activeBoard` is `undefined` until the query first settles. That initial settle
  // (undefined → board | null) is cold-start hydration, NOT a switch, so it must not
  // clear a dismissal that should survive the launch — only a later change does.
  const boardUuid = activeBoard?.uuid ?? null;
  const prevBoardUuidRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (activeBoard === undefined) return;
    if (prevBoardUuidRef.current === undefined) {
      prevBoardUuidRef.current = boardUuid;
      return;
    }
    if (boardUuid !== prevBoardUuidRef.current) {
      prevBoardUuidRef.current = boardUuid;
      resetAccessoryDismiss();
    }
  }, [activeBoard, boardUuid]);
}
