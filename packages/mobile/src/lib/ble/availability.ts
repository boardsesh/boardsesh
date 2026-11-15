import { bluetoothTransport } from './transport-runtime';
import { State } from 'react-native-ble-plx';
import { getBleManager } from './ble-manager';
import {
  allowsBluetoothUse,
  readBluetoothAuthorization,
  requestBluetoothAuthorization,
} from './bluetooth-authorization';
import { setBackgroundSafeTimeout } from './background-safe-timeout';

const DEFAULT_BLE_POWERED_ON_TIMEOUT_MS = 2_500;

type BleStateSubscription = {
  remove(): void;
};

function isTransientBleState(state: State): boolean {
  return state === State.Unknown || state === State.Resetting || state === State.Unauthorized;
}

export async function waitForBlePoweredOn(timeoutMs = DEFAULT_BLE_POWERED_ON_TIMEOUT_MS): Promise<boolean> {
  const transport = bluetoothTransport();
  if (transport) return transport.waitForPoweredOn(timeoutMs);
  let authorization = readBluetoothAuthorization();
  if (authorization === 'notDetermined') authorization = await requestBluetoothAuthorization();
  if (!allowsBluetoothUse(authorization)) return false;

  let currentState: State;
  try {
    currentState = await getBleManager().state();
  } catch {
    return false;
  }

  if (currentState === State.PoweredOn) {
    return true;
  }

  if (!isTransientBleState(currentState)) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let cancelTimeout: (() => void) | null = null;
    let subscription: BleStateSubscription | null = null;
    let removeAfterSubscribe = false;

    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      cancelTimeout?.();
      if (subscription) {
        subscription.remove();
      } else {
        removeAfterSubscribe = true;
      }
      resolve(available);
    };

    // On the native clock too: a background connect (the session notification's
    // bulb) would otherwise wait here until Android resumed JS timers (#7038).
    cancelTimeout = setBackgroundSafeTimeout(() => finish(false), timeoutMs);

    try {
      subscription = getBleManager().onStateChange((nextState) => {
        if (nextState === State.PoweredOn) {
          finish(true);
          return;
        }

        if (!isTransientBleState(nextState)) {
          finish(false);
        }
      }, true);

      if (removeAfterSubscribe) {
        subscription.remove();
      }
    } catch {
      finish(false);
    }
  });
}
