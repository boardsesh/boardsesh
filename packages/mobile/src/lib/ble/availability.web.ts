import { isWebBluetoothAvailable } from './web-adapter';

// Web has no "powered on" radio state to poll (that's a native ble-plx concept).
// The only availability signal is whether the browser exposes Web Bluetooth at
// all, so resolve immediately with that. Non-Chromium browsers resolve false and
// the shared BLE UI shows its existing "Bluetooth unavailable" state.
export function waitForBlePoweredOn(_timeoutMs?: number): Promise<boolean> {
  return Promise.resolve(isWebBluetoothAvailable());
}
