import { State } from 'react-native-ble-plx';
import { bleManager } from './ble-manager';

const DEFAULT_BLE_POWERED_ON_TIMEOUT_MS = 2_500;

type BleStateSubscription = {
  remove(): void;
};

function isTransientBleState(state: State): boolean {
  return state === State.Unknown || state === State.Resetting || state === State.Unauthorized;
}

export async function waitForBlePoweredOn(timeoutMs = DEFAULT_BLE_POWERED_ON_TIMEOUT_MS): Promise<boolean> {
  let currentState: State;
  try {
    currentState = await bleManager.state();
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
      subscription = bleManager.onStateChange((nextState) => {
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
