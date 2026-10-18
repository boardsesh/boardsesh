import { State } from 'react-native-ble-plx';
import { getBleManager } from './ble-manager';
import {
  allowsBluetoothUse,
  readBluetoothAuthorization,
  requestBluetoothAuthorization,
} from './bluetooth-authorization';

const DEFAULT_BLE_POWERED_ON_TIMEOUT_MS = 2_500;

type BleStateSubscription = {
  remove(): void;
};

function isTransientBleState(state: State): boolean {
  return state === State.Unknown || state === State.Resetting || state === State.Unauthorized;
}

export async function waitForBlePoweredOn(timeoutMs = DEFAULT_BLE_POWERED_ON_TIMEOUT_MS): Promise<boolean> {
  // The fake-Bluetooth screenshot build (see screenshot-fake-adapter.ts) runs on
  // a simulator whose radio reads Unsupported. Inlined so it folds away elsewhere.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1')
    return true;

  // Every caller is a scan or connect the climber started, so this is where an
  // iOS phone that has never answered the Bluetooth question gets asked. The
  // native ask shows the alert and waits for the answer; ble-plx below then
  // starts with the answer known, so it shows nothing. A no (or no answer yet)
  // ends here, before ble-plx exists: readBluetoothUnavailableReason reads why
  // without it. Null (Android, web, an older binary): carry on as before, with
  // no extra await, so those paths keep their exact timing.
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
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let subscription: BleStateSubscription | null = null;
    let removeAfterSubscribe = false;

    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (subscription) {
        subscription.remove();
      } else {
        removeAfterSubscribe = true;
      }
      resolve(available);
    };

    timeoutId = setTimeout(() => finish(false), timeoutMs);

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
