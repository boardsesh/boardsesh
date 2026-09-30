import { BleManager, State, type Subscription } from 'react-native-ble-plx';

let manager: BleManager | null = null;

/**
 * The app's one BLE manager. Creating it is what shows iOS's Bluetooth
 * permission prompt, so BluetoothProvider creates it as soon as a board is set
 * up: the prompt then follows board setup, where it makes sense, and has been
 * answered by the time the climber taps Connect.
 */
export function getBleManager(): BleManager {
  manager ??= new BleManager();
  return manager;
}

export type BluetoothAvailability = 'ready' | 'off' | 'unauthorized' | 'unsupported' | 'notReady';

// How long to wait for CoreBluetooth to settle, like Boardsesh's own wait
// (packages/mobile/src/lib/ble/availability.ts).
const STATE_SETTLE_TIMEOUT_MS = 2_500;

/** The answer a state gives for good, or null while it may still change. */
function settledAvailability(state: State): BluetoothAvailability | null {
  switch (state) {
    case State.PoweredOn:
      return 'ready';
    case State.PoweredOff:
      return 'off';
    case State.Unsupported:
      return 'unsupported';
    default:
      // Unknown and Resetting: CoreBluetooth is still settling. Unauthorized
      // can be passing too, right after the permission prompt is answered, so
      // it only counts once it has lasted the whole wait.
      return null;
  }
}

/** Whether Bluetooth can be used right now, waiting briefly for iOS to settle. */
export function checkBluetooth(): Promise<BluetoothAvailability> {
  const bleManager = getBleManager();
  return new Promise((resolve) => {
    let settled = false;
    let lastState: State = State.Unknown;
    let subscription: Subscription | null = null;
    const finish = (availability: BluetoothAvailability) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      resolve(availability);
    };
    const timer = setTimeout(
      () => finish(lastState === State.Unauthorized ? 'unauthorized' : 'notReady'),
      STATE_SETTLE_TIMEOUT_MS,
    );
    subscription = bleManager.onStateChange((state) => {
      lastState = state;
      const availability = settledAvailability(state);
      if (availability) finish(availability);
    }, true);
    // The current state can arrive before `subscription` is assigned.
    if (settled) subscription.remove();
  });
}
