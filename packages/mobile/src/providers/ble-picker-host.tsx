import { createContext, useContext } from 'react';
import type { PickerState } from '../lib/ble/use-board-bluetooth';
import type { BleBoardConfig } from '../lib/ble/board-config-match';

// Dedicated, lightweight context for the BLE device picker so the play route can
// host its OWN picker sheet — presenting ABOVE the modal route — without the
// volatile pickerState (a fresh object on every scan-progress push) polluting the
// widely-consumed BluetoothContext and re-rendering the app. Provided by
// BluetoothProvider; consumed only by DevicePickerSheetHost.
export type BlePickerHostValue = {
  pickerState: PickerState | null;
  /** Connect to the chosen device (BluetoothProvider's handlePickerSelect). */
  onSelect: (deviceId: string) => void;
  /** The active board config, for the picker's match display. */
  currentBoardConfig: BleBoardConfig | undefined;
  /** A route-level host calls this to suppress the app-root picker while it owns
   *  the picker — otherwise a root-presented sheet lands behind the modal route
   *  (and presenting it forces the route to dismiss). */
  setHostedExternally: (hosted: boolean) => void;
  /**
   * Take the wall with no Bluetooth, for the picker's "this wall has no lights"
   * offer after a scan that found nothing. Passed down rather than read back out
   * of BluetoothContext: BluetoothProvider renders the picker, so the picker
   * importing the provider would be a static import cycle.
   */
  onNoLeds: () => void;
};

export const BlePickerHostContext = createContext<BlePickerHostValue | null>(null);

export function useBlePickerHost(): BlePickerHostValue {
  const value = useContext(BlePickerHostContext);
  if (value === null) {
    throw new Error('useBlePickerHost must be used within a BluetoothProvider');
  }
  return value;
}
