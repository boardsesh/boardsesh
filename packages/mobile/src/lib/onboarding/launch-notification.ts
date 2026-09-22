// Whether a notification tap opened the app (#5654). The launch gate stands down
// on it the same way it does on a launch URL: a climber who tapped a friend's
// session invite has somewhere to be, and the first-board picker must not cover
// it.
//
// Its own module so the gate's tests never load expo-notifications, whose native
// bindings do not import under Vitest.

import * as Notifications from 'expo-notifications';

/**
 * True when this process has a notification response: the tap that cold-started
 * the app, or one handled since. Push routing (`setupNotificationHandlers`)
 * answers it with `router.push` to a tab route, so the top segment reads
 * `(tabs)` and `Linking.getInitialURL()` stays null. That is why the URL check
 * alone misses it.
 *
 * The web build has no native module and throws here; that reads as "no".
 */
export function wasOpenedFromNotification(): boolean {
  try {
    return Notifications.getLastNotificationResponse() != null;
  } catch {
    return false;
  }
}
