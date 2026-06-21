import { useSegments } from 'expo-router';
import { isTabsRoute } from '../lib/route-segments';

/**
 * True while the focused route is inside the (tabs) group — i.e. the native tab bar
 * and its bottom accessory are on screen rather than slid away behind a pushed root
 * screen (session detail) or a root modal.
 *
 * Gates the `NativeTabs.BottomAccessory` mount so leaving the tabs group fully
 * unmounts the UIKit accessory host: a clean React unmount removes the
 * `bottomAccessory` and releases its backing view, so on return there's no orphaned
 * glass-platter snapshot to stack under the fresh one (the doubled, offset text).
 * `isTabsRoute` only checks segments[0], so intra-tab navigation (e.g. climbs → a
 * climb detail within the tab stack) doesn't toggle it and never churns the host.
 */
export function useInsideTabs(): boolean {
  return isTabsRoute(useSegments());
}
