// Why Bluetooth can't be used right now, for the two places that stop on it: a
// connect (use-board-bluetooth.ts) and the /boards quickstart scan
// (use-board-scan.ts). Both used to say "Bluetooth is off" for every cause, so a
// climber who had denied the iOS prompt was told to turn on a radio that was
// already on, with no way to fix the real problem (#5654).
//
// The adapters only answer yes/no (`isAvailable`, `waitForBlePoweredOn`), so the
// reason is read after they say no. On iOS binaries that ask at the first scan
// instead of at launch, the permission half comes from the app's authorization
// (bluetooth-authorization.ts), which needs no Bluetooth manager: reading
// ble-plx's state would create its manager, and while the question is still
// unanswered that would raise the alert. Everything else, and every platform
// without that read, comes from the ble-plx manager's radio state. ble-plx runs
// its own CBCentralManager on iOS, and CoreBluetooth reports the same app
// authorization to every manager, so its `Unauthorized` matches what the native
// BoardBle manager saw.
//
// Types only from ble-plx: the web bundle must not load it. On web `getBleManager()`
// resolves to ble-manager.web.ts, whose state() always reads 'PoweredOff'.

import { Platform } from 'react-native';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { getBleManager } from './ble-manager';
import { isBluetoothAuthorizationRefused, readBluetoothAuthorization } from './bluetooth-authorization';

/**
 * 'unknown' covers a stop the radio state can't explain: still Unknown or
 * Resetting when the adapter gave up, PoweredOn (an error that classified as
 * unavailable, e.g. Android location services off), or an unreadable state. Its
 * copy stays the generic "Bluetooth is off" message, as before #5654.
 *
 * 'not_asked' is iOS only: the climber has never answered the Bluetooth alert
 * (it was still on screen when the flow gave up). Nothing is wrong, so it is
 * never reported as Bluetooth Unavailable, and the copy asks them to allow it.
 */
export type BluetoothUnavailableReason = 'unauthorized' | 'powered_off' | 'unsupported' | 'unknown' | 'not_asked';

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

// How long to wait for a just-created ble-plx manager's first radio state.
const SETTLED_RADIO_STATE_TIMEOUT_MS = 1_000;

function isUnsettledRadioState(radioState: string): boolean {
  return radioState === 'Unknown' || radioState === 'Resetting';
}

/**
 * ble-plx's radio state once it has reported a real one. Since the manager is
 * created on first use (ble-manager.ts), on iOS this read can be the one that
 * creates it, and a new manager reads Unknown until CoreBluetooth's first
 * update a few milliseconds later. Read that early, a radio that is simply off
 * would show the generic copy. Waits up to a second, then returns the last
 * state seen. Android reads the adapter state directly, so it keeps the single
 * read it always had.
 */
async function readRadioState(): Promise<string> {
  const bleManager = getBleManager();
  const currentState: string = await bleManager.state();
  if (Platform.OS !== 'ios' || !isUnsettledRadioState(currentState)) return currentState;

  return new Promise<string>((resolve) => {
    let settled = false;
    let latestState = currentState;
    let subscription: { remove(): void } | null = null;
    let removeAfterSubscribe = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (subscription) {
        subscription.remove();
      } else {
        removeAfterSubscribe = true;
      }
      resolve(latestState);
    };

    const timeoutId = setTimeout(finish, SETTLED_RADIO_STATE_TIMEOUT_MS);

    try {
      subscription = bleManager.onStateChange((nextState) => {
        latestState = nextState;
        if (!isUnsettledRadioState(nextState)) finish();
      }, true);
      if (removeAfterSubscribe) subscription.remove();
    } catch {
      finish();
    }
  });
}

/**
 * Read why Bluetooth is unavailable after an adapter reported it. Never throws:
 * a failed read is 'unknown', which keeps the pre-#5654 copy.
 */
export async function readBluetoothUnavailableReason(): Promise<BluetoothUnavailableReason> {
  const authorization = readBluetoothAuthorization();
  if (authorization === 'notDetermined') return 'not_asked';
  if (isBluetoothAuthorizationRefused(authorization)) return 'unauthorized';
  try {
    return bluetoothUnavailableReasonForState(await readRadioState());
  } catch {
    return 'unknown';
  }
}

export function trackBluetoothUnavailable(
  reason: BluetoothUnavailableReason,
  surface: BluetoothUnavailableSurface,
  boardName?: string,
): void {
  // An unanswered question is not Bluetooth being unavailable: counting it would
  // read as a fault in the series that measures real ones.
  if (reason === 'not_asked') return;
  track(SHARED_EVENTS.BluetoothUnavailable, {
    reason,
    surface,
    platform: Platform.OS,
    ...(boardName ? { boardName } : {}),
  });
}
