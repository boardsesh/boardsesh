import type { ReactNode } from 'react';
import { BlePickerHostContext, type BlePickerHostValue } from './ble-picker-host';

const ignorePickerAction = () => undefined;
const WEB_BLE_PICKER_HOST: BlePickerHostValue = {
  pickerState: null,
  onSelect: ignorePickerAction,
  currentBoardConfig: undefined,
  setHostedExternally: ignorePickerAction,
};

/**
 * Web Bluetooth is not supported by the Expo app yet. Leaving the Bluetooth
 * provider out makes optional BLE consumers hide or disable their controls
 * instead of exposing actions backed by the rejecting web adapter. The play
 * route still mounts its lightweight device-picker host, so provide that host
 * with an inert value to keep the route renderable.
 */
export function BluetoothProviderWrapper({ children }: { children: ReactNode }) {
  return <BlePickerHostContext.Provider value={WEB_BLE_PICKER_HOST}>{children}</BlePickerHostContext.Provider>;
}
