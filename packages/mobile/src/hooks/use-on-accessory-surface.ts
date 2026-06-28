import { useSegments } from 'expo-router';
import { isAccessorySurfaceRoute } from '../lib/route-segments';

/**
 * True on the surfaces where the current-climb bottom accessory should be MOUNTED —
 * a top-level tab page (a tab's own index), OR under the player route (`/play`).
 *
 * Gates the `NativeTabs.BottomAccessory` host mount. Leaving a top-level tab — to a
 * pushed sub-route in the same tab (session detail, settings, climb filters) or to a
 * root push/modal (boards / share-beta) — fully unmounts the host. That's a clean
 * React unmount that releases the backing view, so UIKit doesn't leave a stale
 * glass-platter snapshot stacked under the fresh one on return (the doubled, offset
 * climb name).
 *
 * The player is the exception. It's a `transparentModal` (see app/_layout.tsx), so
 * the tabs screen stays LIVE behind it — UIKit never snapshots the presenting view
 * controller (the way a `fullScreenModal` does) and never removes the accessory's
 * backing view. Unmounting the accessory under the player would instead CHURN the
 * native tab-bar height (the docked Climbs search field jumps); keeping it mounted
 * under the transparent modal is both stable AND snapshot-free, so there's nothing
 * to double. `isAccessorySurfaceRoute` keeps it mounted there.
 */
export function useOnAccessorySurface(): boolean {
  return isAccessorySurfaceRoute(useSegments());
}
