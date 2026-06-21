import { useCallback, useEffect, useState } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import { State } from 'react-native-ble-plx';
import { bleManager } from './ble-manager';

type AndroidPermission = (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS];

type BlePermissionsResult = {
  bleState: State;
  isAvailable: boolean;
  requestPermissions: () => Promise<boolean>;
};

type BleRuntimePermissionOptions = {
  requestNotificationPermission?: boolean;
};

function androidApiLevel(): number {
  if (typeof Platform.Version === 'number') {
    return Platform.Version;
  }

  const parsedVersion = Number.parseInt(String(Platform.Version), 10);
  return Number.isNaN(parsedVersion) ? 0 : parsedVersion;
}

async function requestOptionalNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || androidApiLevel() < 33) return;

  try {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  } catch {
    // Notification permission is optional for BLE continuity - ignore failures.
  }
}

export async function requestBleRuntimePermissions({
  requestNotificationPermission = false,
}: BleRuntimePermissionOptions = {}): Promise<boolean> {
  if (Platform.OS === 'ios') {
    // iOS handles BLE permissions via Info.plist entries; the system prompts
    // automatically on first scan. No runtime permission request needed, and
    // radio state is checked separately by scan/connect availability guards.
    return true;
  }

  if (Platform.OS !== 'android') {
    return true;
  }

  const requiredPermissions: AndroidPermission[] =
    androidApiLevel() >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  try {
    const permissionResults = await PermissionsAndroid.requestMultiple(requiredPermissions);
    const requiredPermissionsGranted = requiredPermissions.every(
      (permission) => permissionResults[permission] === PermissionsAndroid.RESULTS.GRANTED,
    );

    if (requestNotificationPermission) {
      // POST_NOTIFICATIONS (Android 13+) lets the session foreground-service show
      // its ongoing notification with Previous/Next controls. Requested at
      // connect time, but decoupled from the BLE gate: a denial only hides the
      // notification; the foreground service still runs and keeps the board
      // connection alive in the background.
      await requestOptionalNotificationPermission();
    }

    return requiredPermissionsGranted;
  } catch {
    return false;
  }
}

export function useBlePermissions(): BlePermissionsResult {
  const [bleState, setBleState] = useState<State>(State.Unknown);

  useEffect(() => {
    const subscription = bleManager.onStateChange((newState) => {
      setBleState(newState);
    }, true);

    return () => subscription.remove();
  }, []);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    return requestBleRuntimePermissions({ requestNotificationPermission: true });
  }, []);

  return {
    bleState,
    isAvailable: bleState === State.PoweredOn,
    requestPermissions,
  };
}
