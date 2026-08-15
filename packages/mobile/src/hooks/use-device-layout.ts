import { useMemo } from 'react';
import { Dimensions, Platform, useWindowDimensions } from 'react-native';
import {
  resolveDeviceLayout,
  resolveIsTablet,
  resolveWallDeviceClass,
  type DeviceLayout,
  type WallDeviceClass,
} from '../theme/size-class';

/**
 * The adaptive shell's size class, recomputed as the app window resizes —
 * rotation, Stage Manager, Split View / Slide Over, Android multi-window. A phone
 * is always `compact`; a tablet is `regular` once its window is wide enough for
 * the sidebar plus a content pane, and falls back to `compact` (the phone UI
 * verbatim) in a narrow split. The arithmetic lives in the pure
 * `resolveDeviceLayout` so it is unit-tested without react-native.
 *
 * `isTablet` is surfaced alongside the size class so the shell can keep a tablet
 * on a single JS `Tabs` navigator across the regular↔compact boundary (a tablet
 * in a narrow split is `compact` but must NOT swap to NativeTabs, or the boundary
 * cross would remount the navigator). It is launch-fixed — an iPad (`Platform.isPad`)
 * an Android tablet, or a qualifying web screen (`sw600dp`, see
 * `resolveIsTablet`) — unlike `widthClass`, which is live.
 *
 * `wallDeviceClass` is the other launch-fixed axis: whether the device is
 * physically large enough for the persistent wall panel, from the screen long
 * side (see `resolveWallDeviceClass`). Both the long side (wall panel) and the
 * short side (Android/web tablet eligibility) are read from `Dimensions.get('screen')`
 * — the PHYSICAL screen, not the app window (which shrinks under Split View /
 * multi-window / DeX) — and rotation-invariant via `max`/`min`, so memoized once.
 */
export function useDeviceLayout(): DeviceLayout & {
  isPad: boolean;
  isTablet: boolean;
  wallDeviceClass: WallDeviceClass;
} {
  const { width } = useWindowDimensions();
  // `Platform.isPad` is iOS-only (undefined on Android), so guard on the OS too.
  const isPad = Platform.OS === 'ios' && Platform.isPad === true;
  const { screenLongSide, screenShortSide } = useMemo(() => {
    const screen = Dimensions.get('screen');
    return {
      screenLongSide: Math.max(screen.width, screen.height),
      screenShortSide: Math.min(screen.width, screen.height),
    };
  }, []);
  // Adaptive-shell eligibility: an iPad, or an Android/web screen at sw600dp.
  // Launch-fixed, so an eligible device in a small split/browser window is still
  // a tablet surface but reads `compact` from the live width.
  const isTablet = resolveIsTablet({ platformOS: Platform.OS, isPad, screenShortSide });
  // Android tablets and qualifying web screens are panel-capable regardless of
  // the long side (the live width budget decides the surface); only iPad consults
  // the points floor.
  const wallDeviceClass = resolveWallDeviceClass({ screenLongSide, isPad, isTablet, platformOS: Platform.OS });
  return useMemo(
    () => ({ ...resolveDeviceLayout({ width, isTablet }), isPad, isTablet, wallDeviceClass }),
    [width, isPad, isTablet, wallDeviceClass],
  );
}
