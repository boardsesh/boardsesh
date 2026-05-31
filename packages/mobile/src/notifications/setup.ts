import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// expo-constants' executionEnvironment indicates whether we're in Expo Go or
// a native build. Physical devices in native builds get real push tokens;
// Expo Go and simulators do not.
const canRegisterForPush = Constants.executionEnvironment === 'bare' || Constants.executionEnvironment === 'standalone';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // shouldShowAlert is deprecated in expo-notifications 56 — shouldShowBanner
    // and shouldShowList replace it.
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    priority: Notifications.AndroidNotificationPriority.HIGH,
  }),
});

export async function requestPushPermission(): Promise<boolean> {
  if (!canRegisterForPush) return false;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

export async function getDevicePushToken(): Promise<string | null> {
  if (!canRegisterForPush) return null;

  try {
    const hasPermission = await requestPushPermission();
    if (!hasPermission) return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const tokenData = await Notifications.getDevicePushTokenAsync();
    return tokenData.data;
  } catch {
    return null;
  }
}

export function addPushTokenListener(callback: (token: string) => void): Notifications.Subscription {
  return Notifications.addPushTokenListener((tokenData) => {
    callback(tokenData.data);
  });
}
