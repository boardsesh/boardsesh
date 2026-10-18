import { isWebBluetoothAvailable } from './web-adapter';
import type { BleRuntimePermissionStatus } from './use-ble-permissions';

// Web Bluetooth has no separate runtime-permission grant: the permission prompt
// is the browser's device chooser, shown by navigator.bluetooth.requestDevice on
// a user gesture. So "permissions granted" collapses to "the browser supports
// Web Bluetooth" — the actual per-device consent happens at connect time.
export function requestBleRuntimePermissions(_options?: { requestNotificationPermission?: boolean }): Promise<boolean> {
  return Promise.resolve(isWebBluetoothAvailable());
}

// Same contract as the native module. A browser without Web Bluetooth (Safari,
// Firefox, every iOS browser) is 'unsupported', not 'denied': there is no grant
// for the climber to give, so asking them to allow Bluetooth, or offering to
// scan again, would be a dead end. Callers show the "Bluetooth unavailable" copy
// that availability.web.ts describes as the intended web state.
export function requestBleRuntimePermissionStatus(_options?: {
  requestNotificationPermission?: boolean;
}): Promise<BleRuntimePermissionStatus> {
  return Promise.resolve(isWebBluetoothAvailable() ? 'granted' : 'unsupported');
}

// Browsers have no Android foreground-service notification to ask for.
export function requestOptionalNotificationPermission(): Promise<void> {
  return Promise.resolve();
}
