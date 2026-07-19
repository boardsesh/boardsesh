import type { State } from 'react-native-ble-plx';
import { isWebBluetoothAvailable } from './web-adapter';

type BlePermissionsResult = {
  bleState: State;
  isAvailable: boolean;
  requestPermissions: () => Promise<boolean>;
};

// ble-plx's State enum is native-only; on web we map the single Web Bluetooth
// availability signal onto the two states the shared UI actually branches on.
const POWERED_ON = 'PoweredOn' as unknown as State;
const UNSUPPORTED = 'Unsupported' as unknown as State;

// Web Bluetooth has no separate runtime-permission grant: the permission prompt
// is the browser's device chooser, shown by navigator.bluetooth.requestDevice on
// a user gesture. So "permissions granted" collapses to "the browser supports
// Web Bluetooth" — the actual per-device consent happens at connect time.
export function requestBleRuntimePermissions(_options?: { requestNotificationPermission?: boolean }): Promise<boolean> {
  return Promise.resolve(isWebBluetoothAvailable());
}

export function useBlePermissions(): BlePermissionsResult {
  const available = isWebBluetoothAvailable();
  return {
    bleState: available ? POWERED_ON : UNSUPPORTED,
    isAvailable: available,
    requestPermissions: () => Promise.resolve(available),
  };
}
