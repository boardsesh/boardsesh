import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import type { BleWriteActivityStore } from '../lib/ble/write-activity-store';

const BluetoothWriteActivityContext = createContext<BleWriteActivityStore | null>(null);

const subscribeToNothing = () => () => {};
export const getBleWriteActivityServerSnapshot = () => false;

export function BluetoothWriteActivityProvider({
  store,
  children,
}: {
  store: BleWriteActivityStore;
  children?: ReactNode;
}) {
  return <BluetoothWriteActivityContext.Provider value={store}>{children}</BluetoothWriteActivityContext.Provider>;
}

/**
 * Subscribe only the leaf that paints BLE write feedback. The main Bluetooth
 * context intentionally excludes this volatile state so a packet does not
 * rerender the navigation tree.
 */
export function useBluetoothWriteInProgress(): boolean {
  const store = useContext(BluetoothWriteActivityContext);
  return useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    store?.getSnapshot ?? getBleWriteActivityServerSnapshot,
    getBleWriteActivityServerSnapshot,
  );
}
