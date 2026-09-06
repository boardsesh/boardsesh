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
 * Mounted is not the same as presented, and on device they diverge: UIKit still stops
 * drawing the platter once you push (verified on the playlist route — visible at the
 * Discover root, gone on the detail screen), even though the host is now held open
 * underneath. So this predicate governs the UIKit host only. Anything about what the
 * climber can SEE — the bottom-chrome reserve, the JS `PersistentQueueBar` — keeps
 * using the narrower `isAccessorySurfaceRoute`, or it reserves space for a platter
 * that isn't there.
 */
export function useAccessoryHostRoute(): boolean {
  return isAccessoryHostRoute(useSegments());
}
