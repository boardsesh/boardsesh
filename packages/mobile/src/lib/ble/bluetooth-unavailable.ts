// Why Bluetooth can't be used right now, for the two places that stop on it: a
// connect (use-board-bluetooth.ts) and the /boards quickstart scan
// (use-board-scan.ts). Both used to say "Bluetooth is off" for every cause, so a
// climber who had denied the iOS prompt (which appears at app launch) was told to
// turn on a radio that was already on, with no way to fix the real problem (#5654).
//
// The adapters only answer yes/no (`isAvailable`, `waitForBlePoweredOn`), so the
// reason is read from the ble-plx manager's radio state after they say no. ble-plx
// runs its own CBCentralManager on iOS, and CoreBluetooth reports the same app
// authorization to every manager, so its `Unauthorized` matches what the native
// BoardBle manager saw.
//
// Types only from ble-plx: the web bundle must not load it. On web `bleManager`
// resolves to ble-manager.web.ts, whose state() always reads 'PoweredOff'.

import { Platform } from 'react-native';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { bleManager } from './ble-manager';

/**
 * 'unknown' covers a stop the radio state can't explain: still Unknown or
 * Resetting when the adapter gave up, PoweredOn (an error that classified as
 * unavailable, e.g. Android location services off), or an unreadable state. Its
 * copy stays the generic "Bluetooth is off" message, as before #5654.
 */
export type BluetoothUnavailableReason = 'unauthorized' | 'powered_off' | 'unsupported' | 'unknown';

export type BluetoothUnavailableSurface = 'connect' | 'quickstart_scan';

/** Map a ble-plx `State` value to the reason the climber is shown. */
export function bluetoothUnavailableReasonForState(radioState: string): BluetoothUnavailableReason {
  switch (radioState) {
    case 'Unauthorized':
      return 'unauthorized';
    case 'PoweredOff':
      return 'powered_off';
    case 'Unsupported':
      return 'unsupported';
    default:
      return 'unknown';
  }
}

/**
 * Read the radio state after an adapter reported Bluetooth unavailable. Never
 * throws: a failed read is 'unknown', which keeps the pre-#5654 copy.
 */
export async function readBluetoothUnavailableReason(): Promise<BluetoothUnavailableReason> {
  try {
    return bluetoothUnavailableReasonForState(await bleManager.state());
  } catch {
    return 'unknown';
  }
}

export function trackBluetoothUnavailable(
  reason: BluetoothUnavailableReason,
  surface: BluetoothUnavailableSurface,
  boardName?: string,
): void {
  track(SHARED_EVENTS.BluetoothUnavailable, {
    reason,
    surface,
    platform: Platform.OS,
    ...(boardName ? { boardName } : {}),
  });
}
