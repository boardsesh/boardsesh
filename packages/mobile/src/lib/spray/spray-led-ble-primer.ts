import { Alert, PermissionsAndroid, Platform } from 'react-native';
import { androidApiLevel } from '../ble/android-location-permission';
import { readBluetoothAuthorization } from '../ble/bluetooth-authorization';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../privacy/privacy-cache';
let dismissed = false;
let explained = false;
subscribeToCredentialChanges(() => {
  dismissed = false;
  explained = false;
});
export async function explainSprayBluetooth(
  copy: { title: string; body: string; allow: string; notNow: string },
  signal?: AbortSignal,
): Promise<boolean> {
  const generation = getCredentialGeneration();
  if (signal?.aborted || dismissed) return false;
  if (explained) return true;
  let alreadyAllowed = Platform.OS !== 'android';
  if (Platform.OS === 'ios') alreadyAllowed = readBluetoothAuthorization() !== 'notDetermined';
  if (Platform.OS === 'android') {
    const permissions =
      androidApiLevel() >= 31
        ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    try {
      alreadyAllowed = (await Promise.all(permissions.map((permission) => PermissionsAndroid.check(permission)))).every(
        Boolean,
      );
    } catch {
      alreadyAllowed = false;
    }
  }
  if (signal?.aborted || generation !== getCredentialGeneration()) return false;
  if (alreadyAllowed) return true;
  const accepted = await new Promise<boolean>((resolve) => {
    const abort = () => resolve(false);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (answer: boolean) => {
      signal?.removeEventListener('abort', abort);
      resolve(answer);
    };
    Alert.alert(
      copy.title,
      copy.body,
      [
        { text: copy.notNow, style: 'cancel', onPress: () => finish(false) },
        { text: copy.allow, onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
  if (signal?.aborted || generation !== getCredentialGeneration()) return false;
  explained = accepted;
  dismissed = !accepted;
  return accepted;
}
