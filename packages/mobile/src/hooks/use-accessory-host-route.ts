import { useSegments } from 'expo-router';
import { isAccessoryHostRoute } from '../lib/route-segments';

/**
 * True where the `NativeTabs.BottomAccessory` HOST must stay MOUNTED — anywhere the
 * iOS 26 tab bar is on screen: any route inside the tabs group, pushed sub-routes
 * included, plus the `transparentModal` player route (`/play`).
 *
 * The accessory is a child of the tab bar, so mounting or unmounting it re-lays-out
 * the bar. Unmounting on a push therefore ran `setBottomAccessory:nil` with the bar
 * still on screen, and left the docked `role="search"` Climbs item with a stale frame
 * — visually shoved and hit-testing to nowhere — until the app was force-quit (#5055;
 * the same failure `126538345` device-observed on the player route and fixed the same
 * way). The host now mounts exactly when the bar is up, and unmounts only when the
 * whole tab view controller leaves, where the accessory co-detaches with the bar.
 *
 * On iOS 26 that means the glass climb platter is VISIBLE on pushed tab sub-routes
 * (playlist detail, session detail, the climb filters). That is the deliberate price
 * of the fix, and it only applies to the native platter: the JS `PersistentQueueBar`
 * on Android / iOS < 26 still hides on sub-routes via `isAccessorySurfaceRoute`.
 */
export function useAccessoryHostRoute(): boolean {
  return isAccessoryHostRoute(useSegments());
}
