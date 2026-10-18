// When the iOS Bluetooth question gets asked.
//
// iOS shows its "allow Bluetooth" alert the moment anything creates a
// CBCentralManager while the app's authorization is still undetermined. Two
// things used to do that at launch, before sign-in and with nothing on screen
// to explain it: the native BoardBle module and ble-plx's BleManager. Binaries
// that expose `getBluetoothAuthorization` create neither until the climber
// scans or connects, and this module is how JS keeps to that:
//
// - `requestBluetoothAuthorization()` at the scan or connect tap
//   (waitForBlePoweredOn, NativeIosBleAdapter.isAvailable): shows the alert and
//   waits for the answer, so the scan carries on after an Allow, and ble-plx is
//   only created once the answer is known (ble-manager.ts).
// - `readBluetoothAuthorization()` to explain an "unavailable" without creating
//   ble-plx (bluetooth-unavailable.ts): an unanswered question is "not asked
//   yet", not a fault.
//
// Android asks for its runtime permissions at scan/connect already
// (use-ble-permissions.ts) and is untouched: the BoardBle module is registered
// for iOS only (modules/live-activity/expo-module.config.json), so every read
// here is null there, as it is on web and on an iOS binary older than the
// native functions, and null means "keep the old behaviour". Gating on the
// module rather than on `Platform` also keeps react-native out of this file.

import { boardBleNative, type NativeBluetoothAuthorization } from '../../../modules/live-activity/src/index';

export type BluetoothAuthorization = NativeBluetoothAuthorization;

const KNOWN_AUTHORIZATIONS: readonly BluetoothAuthorization[] = [
  'notDetermined',
  'allowedAlways',
  'denied',
  'restricted',
];

function parseBluetoothAuthorization(rawAuthorization: unknown): BluetoothAuthorization | null {
  return KNOWN_AUTHORIZATIONS.find((authorization) => authorization === rawAuthorization) ?? null;
}

/**
 * The app's iOS Bluetooth authorization, read without creating any Bluetooth
 * manager (so it never shows the alert). Null when it can't be known: Android,
 * web, an iOS binary older than the native read, or a native error.
 */
export function readBluetoothAuthorization(): BluetoothAuthorization | null {
  const native = boardBleNative;
  if (!native || typeof native.getBluetoothAuthorization !== 'function') return null;
  try {
    return parseBluetoothAuthorization(native.getBluetoothAuthorization());
  } catch {
    return null;
  }
}

/** True when iOS says the climber (or a device policy) said no to Bluetooth. */
export function isBluetoothAuthorizationRefused(authorization: BluetoothAuthorization | null): boolean {
  return authorization === 'denied' || authorization === 'restricted';
}

/**
 * Whether a scan or connect may go on to Bluetooth with this answer: allowed,
 * or null (nothing to ask through, so the old path). A no, or a question still
 * unanswered, stops it before any Bluetooth manager exists.
 */
export function allowsBluetoothUse(authorization: BluetoothAuthorization | null): boolean {
  return authorization !== 'notDetermined' && !isBluetoothAuthorizationRefused(authorization);
}

/**
 * Ask for Bluetooth, for the scan or connect tap. When the question is
 * unanswered this shows the system alert and resolves once the climber
 * answers; otherwise it resolves the existing answer straight away. Never
 * throws. Null means there is nothing to ask through (see the header): the
 * caller carries on exactly as before.
 */
export async function requestBluetoothAuthorization(): Promise<BluetoothAuthorization | null> {
  const currentAuthorization = readBluetoothAuthorization();
  if (currentAuthorization !== 'notDetermined') return currentAuthorization;
  const native = boardBleNative;
  if (!native || typeof native.requestBluetoothAuthorization !== 'function') return currentAuthorization;
  try {
    return parseBluetoothAuthorization(await native.requestBluetoothAuthorization());
  } catch {
    return readBluetoothAuthorization();
  }
}
