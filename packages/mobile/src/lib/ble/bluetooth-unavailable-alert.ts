// What a connect tells the climber when Bluetooth can't be used. Split from
// bluetooth-unavailable.ts so the quickstart scan, which renders its own sheet
// state, doesn't pull in Alert.

import { Alert, Platform, type AlertButton } from 'react-native';
import type { TFunction } from 'i18next';
import { canOpenAppSettings, openAppSettings } from '../open-app-settings';
import { androidApiLevel } from './android-location-permission';
import {
  readBluetoothUnavailableReason,
  trackBluetoothUnavailable,
  type BluetoothUnavailableReason,
} from './bluetooth-unavailable';

/**
 * The "Bluetooth is blocked" body, naming the permission the way this phone's
 * Settings app labels it. iOS has a Bluetooth switch per app. Android 12+ files
 * Bluetooth scanning under "Nearby devices", and Android 11 and older gate it on
 * Location, so "Allow Bluetooth" would send an Android climber looking for a
 * switch that isn't there.
 */
export function bluetoothBlockedBody(t: TFunction<'settings'>): string {
  if (Platform.OS === 'android') {
    return androidApiLevel() >= 31 ? t('ble.blockedBodyNearbyDevices') : t('ble.blockedBodyLocation');
  }
  return t('ble.blockedBody');
}

type AlertBluetoothUnavailableOptions = {
  /** Already known (an Android never-ask-again answer). Read from the radio when omitted. */
  reason?: BluetoothUnavailableReason;
  boardName?: string;
  t: TFunction<'settings'>;
  tCommon: TFunction<'common'>;
};

/**
 * Tell the climber why a connect stopped, and record it as Bluetooth Unavailable.
 * Blocked gets its own title and an Open Settings button; every other reason keeps
 * the existing "Bluetooth is off" copy, which is right for a radio that's off.
 */
export async function alertBluetoothUnavailable({
  reason,
  boardName,
  t,
  tCommon,
}: AlertBluetoothUnavailableOptions): Promise<BluetoothUnavailableReason> {
  const resolvedReason = reason ?? (await readBluetoothUnavailableReason());
  trackBluetoothUnavailable(resolvedReason, 'connect', boardName);

  if (resolvedReason !== 'unauthorized') {
    // The i18n checker only resolves a translator named `t` here, so it can't see
    // this lookup through `tCommon`.
    // i18n-keep common:bluetooth.unavailable
    Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.unavailable'));
    return resolvedReason;
  }

  const buttons: AlertButton[] = [{ text: t('ble.cancel'), style: 'cancel' }];
  // Expo web has no Settings deep link; the button would do nothing there.
  if (canOpenAppSettings()) {
    buttons.push({
      text: t('ble.openSettings'),
      onPress: () => {
        void openAppSettings();
      },
    });
  }
  Alert.alert(t('ble.blockedTitle'), bluetoothBlockedBody(t), buttons);
  return resolvedReason;
}
