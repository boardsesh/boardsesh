import { Alert, PermissionsAndroid, Platform } from 'react-native';
import { androidApiLevel } from '../ble/android-location-permission';
import { readBluetoothAuthorization } from '../ble/bluetooth-authorization';
import { getPreference, setPreference } from '../preference-store';

/**
 * A held climb on a Bluetooth Spraywall is the first time some climbers' phones
 * use Bluetooth at all, so the system prompt would arrive mid-climb with nothing
 * saying why. Once, before that first prompt, the app explains it.
 */
const PRIMED_KEY = 'sprayLedBluetoothPrimed';

async function bluetoothAlreadyAllowed(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    // null: an older binary that asks at launch, so nothing is left to ask.
    const authorization = readBluetoothAuthorization();
    return authorization !== 'notDetermined';
  }
  if (Platform.OS !== 'android') return true;
  const required =
    androidApiLevel() >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  try {
    const granted = await Promise.all(required.map((permission) => PermissionsAndroid.check(permission)));
    return granted.every(Boolean);
  } catch {
    return false;
  }
}

/** True when this phone has never been told and the system would still ask. */
export async function sprayLedBluetoothNeedsPrimer(): Promise<boolean> {
  try {
    if ((await getPreference<boolean>(PRIMED_KEY)) === true) return false;
  } catch {
    // An unreadable flag asks again rather than prompting with no context.
  }
  return !(await bluetoothAlreadyAllowed());
}

export async function markSprayLedBluetoothPrimed(): Promise<void> {
  await setPreference(PRIMED_KEY, true).catch(() => undefined);
}

export type SprayLedBluetoothPrimerCopy = { title: string; body: string; allow: string; notNow: string };

/**
 * The explanation, as a system alert: it is raised over the live board sheet,
 * which an in-app dialog would draw behind (as confirm-spray-wall-reset.ts).
 * Resolves true for "Continue"; dismissing it is "Not now".
 */
export function confirmSprayLedBluetooth(copy: SprayLedBluetoothPrimerCopy): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      copy.title,
      copy.body,
      [
        { text: copy.notNow, style: 'cancel', onPress: () => resolve(false) },
        { text: copy.allow, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
