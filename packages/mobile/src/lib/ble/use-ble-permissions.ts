import { useCallback, useEffect, useState } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import { State } from 'react-native-ble-plx';
import { bleManager } from './ble-manager';
import { androidApiLevel } from './android-location-permission';

type AndroidPermission = (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS];

type BlePermissionsResult = {
  bleState: State;
  isAvailable: boolean;
  requestPermissions: () => Promise<boolean>;
};

type BleRuntimePermissionOptions = {
  requestNotificationPermission?: boolean;
};

/**
 * - 'granted': every permission the scan needs is held.
 * - 'denied': the climber said no in the system dialog, or closed it. The next
 *   request shows the dialog again, so asking again from the app is still a real
 *   option.
 * - 'blocked': Android answered `never_ask_again` without showing a dialog, so
 *   only the Settings app can grant it now. iOS never reports this here: its
 *   denial shows up as the `Unauthorized` radio state instead (see
 *   bluetooth-unavailable.ts).
 * - 'unsupported': web only, a browser with no Web Bluetooth (Safari, Firefox,
 *   every iOS browser). There is nothing for the climber to allow.
 */
export type BleRuntimePermissionStatus = 'granted' | 'denied' | 'blocked' | 'unsupported';

/**
 * How long a `never_ask_again` answer may take and still count as Android having
 * shown no dialog. React Native reports `never_ask_again` for any refusal where
 * `shouldShowRequestPermissionRationale` is false, and on Android 11+ that is also
 * true after a climber closes the FIRST dialog with back or a tap outside, which
 * Android doesn't count as a denial (the dialog comes back next time). The two
 * differ in time: with no dialog the answer is one activity round trip, while a
 * dialog has to animate in (~250 ms) and be read before anyone can close it. A
 * slow phone that misses this window reads as 'denied', which is the copy every
 * blocked climber saw before #5654, and never as a false "blocked".
 */
export const ANDROID_NO_DIALOG_ANSWER_MAX_MS = 500;

/**
 * POST_NOTIFICATIONS (Android 13+) lets the session foreground service show its
 * ongoing notification with Previous/Next controls. Optional: a denial only hides
 * the notification, and the service keeps the board connection alive either way.
 * Exported so the connect flow can ask after the board is connected rather than
 * stacking a second system dialog in front of the scan (#5654).
 */
export async function requestOptionalNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || androidApiLevel() < 33) return;

  try {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  } catch {
    // Notification permission is optional for BLE continuity - ignore failures.
  }
}

export async function requestBleRuntimePermissions(options: BleRuntimePermissionOptions = {}): Promise<boolean> {
  return (await requestBleRuntimePermissionStatus(options)) === 'granted';
}

export async function requestBleRuntimePermissionStatus({
  requestNotificationPermission = false,
}: BleRuntimePermissionOptions = {}): Promise<BleRuntimePermissionStatus> {
  if (Platform.OS === 'ios') {
    // iOS handles BLE permissions via Info.plist entries; the system prompts
    // automatically on first scan. No runtime permission request needed, and
    // radio state is checked separately by scan/connect availability guards.
    return 'granted';
  }

  if (Platform.OS !== 'android') {
    return 'granted';
  }

  // The API-31+ branch is only *complete* once BLUETOOTH_SCAN is declared with
  // android:usesPermissionFlags="neverForLocation". Until then Android silently
  // drops every scan result for a caller without location permission — no error,
  // no callback, just an empty list. See android-scan-location-gate.ts.
  // The API<31 branch genuinely needs fine location; there is no way around it.
  const requiredPermissions: AndroidPermission[] =
    androidApiLevel() >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  try {
    const requestStartedAt = Date.now();
    const permissionResults = await PermissionsAndroid.requestMultiple(requiredPermissions);
    const answeredWithoutDialog = Date.now() - requestStartedAt < ANDROID_NO_DIALOG_ANSWER_MAX_MS;
    const missingPermissions = requiredPermissions.filter(
      (permission) => permissionResults[permission] !== PermissionsAndroid.RESULTS.GRANTED,
    );

    if (requestNotificationPermission) {
      // Decoupled from the BLE gate: a denial only hides the notification; the
      // foreground service still runs and keeps the board connection alive.
      await requestOptionalNotificationPermission();
    }

    if (missingPermissions.length === 0) return 'granted';
    // Once Android stops showing the dialog, re-asking from the app is a dead
    // tap; only the Settings app can grant it now. A `never_ask_again` that took
    // long enough for a dialog to have been on screen is a closed dialog (or the
    // second "Don't allow", after which the next tap answers instantly and lands
    // here as blocked), so it keeps the "allow permissions" copy.
    const blockedForGood =
      answeredWithoutDialog &&
      missingPermissions.some(
        (permission) => permissionResults[permission] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
      );
    return blockedForGood ? 'blocked' : 'denied';
  } catch {
    return 'denied';
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
