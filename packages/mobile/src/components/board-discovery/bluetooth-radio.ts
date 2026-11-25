// The picker's way out of "Bluetooth is off" (the In range slot's `blocked_off`
// phase). About 5 times as many climbers reach the picker with the radio off as
// with the permission blocked (333 against 67 people over 60 days), so the line
// leads with the fix rather than a Scan again:
//   - Android: Turn on Bluetooth, which opens the system's own "Allow Boardsesh
//     to turn on Bluetooth?" dialog (ACTION_REQUEST_ENABLE) through
//     `Linking.sendIntent`. JS only: no native module, no fingerprint change.
//   - iOS: there is no API that turns the radio on or opens its switch, so the
//     line says to use Control Center.
// Either way the scan starts by itself once the radio reports on
// (`watchBluetoothPoweredOn`, used by use-picker-board-scan.ts).
//
// Only ever called once a scan has already got as far as the radio, so the
// Bluetooth manager exists and Bluetooth is allowed: reading its state here can
// never raise the iOS permission alert (see ble-manager.ts). Radio states are
// compared as strings, as bluetooth-unavailable.ts does. The manager module is
// loaded on use, not at import: the picker imports this file, and nothing here
// should load ble-plx before a scan has.

import { Linking, Platform } from 'react-native';

type RadioStateSubscription = { remove(): void };

async function loadBleManager() {
  const { getBleManager } = await import('../../lib/ble/ble-manager');
  return getBleManager();
}

/** What the "Bluetooth is off" line offers: the system dialog, or a Control Center hint. */
export type BluetoothOffFix = 'turn_on' | 'control_center';

/** Android can ask to turn the radio on; iOS (and anything else) can only be told where the switch is. */
export function bluetoothOffFix(platformOS: string): BluetoothOffFix {
  return platformOS === 'android' ? 'turn_on' : 'control_center';
}

const REQUEST_ENABLE_ACTION = 'android.bluetooth.adapter.action.REQUEST_ENABLE';
const BLUETOOTH_SETTINGS_ACTION = 'android.settings.BLUETOOTH_SETTINGS';

/**
 * Turn on Bluetooth (Android). `already_on`: the radio came on since the scan
 * gave up, so the caller should just scan; the dialog would show nothing.
 * `asked`: the system dialog (or, where it can't open, the Bluetooth settings
 * page) is up, and the scan starts by itself when the radio reports on. Never
 * throws, so a button handler can call it bare.
 */
export async function turnOnBluetooth(): Promise<'already_on' | 'asked'> {
  if (Platform.OS !== 'android') return 'asked';
  try {
    const radioState: string = await (await loadBleManager()).state();
    if (radioState === 'PoweredOn') return 'already_on';
  } catch {
    // Unreadable: ask anyway, the dialog says nothing harmful when it is on.
  }
  try {
    await Linking.sendIntent(REQUEST_ENABLE_ACTION);
  } catch {
    try {
      await Linking.sendIntent(BLUETOOTH_SETTINGS_ACTION);
    } catch {
      // Nothing more to try: leave the climber on the picker.
    }
  }
  return 'asked';
}

/**
 * Calls `onPoweredOn` the first time the radio reports on after this call
 * (a change, not the state it is already in), then stops listening. Returns
 * the unsubscribe. A manager that can't be listened to calls nothing.
 */
export function watchBluetoothPoweredOn(onPoweredOn: () => void): () => void {
  let done = false;
  let subscription: RadioStateSubscription | null = null;
  void loadBleManager()
    .then((bleManager) => {
      if (done) return;
      subscription = bleManager.onStateChange((radioState: string) => {
        if (done || radioState !== 'PoweredOn') return;
        done = true;
        onPoweredOn();
      }, false);
    })
    .catch(() => {
      // No manager to listen to: Scan again and a fresh picker still work.
    });
  return () => {
    done = true;
    subscription?.remove();
  };
}
