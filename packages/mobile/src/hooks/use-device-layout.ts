import { useMemo } from 'react';
import { Dimensions, Platform, useWindowDimensions } from 'react-native';
import {
  resolveDeviceLayout,
  resolveWallDeviceClass,
  type DeviceLayout,
  type WallDeviceClass,
} from '../theme/size-class';

/**
 * The adaptive shell's size class, recomputed as the app window resizes —
 * rotation, Stage Manager, Split View / Slide Over. iPhone is always `compact`;
 * an iPad is `regular` once its window is wide enough for the sidebar plus a
 * content pane, and falls back to `compact` (the phone UI verbatim) in a narrow
 * split. The arithmetic lives in the pure `resolveDeviceLayout` so it is
 * unit-tested without react-native.
 *
 * `isPad` is surfaced alongside the size class so the shell can keep iPad on a
 * single JS `Tabs` navigator across the regular↔compact boundary (an iPad in a
 * narrow split is `compact` but must NOT swap to NativeTabs, or the boundary
 * cross would remount the navigator). It is launch-fixed (`Platform.isPad`),
 * unlike `widthClass`, which is live.
 *
 * `wallDeviceClass` is the other launch-fixed axis: whether the device is
 * physically large enough for the persistent wall panel, from the screen long
 * side (see `resolveWallDeviceClass`). It's read from `Dimensions.get('screen')`
 * — the PHYSICAL screen, not the app window (which shrinks under Split View /
 * Stage Manager) — and rotation-invariant via `max`, so it's memoized once.
 */
export function useDeviceLayout(): DeviceLayout & { isPad: boolean; wallDeviceClass: WallDeviceClass } {
  const { width } = useWindowDimensions();
  // `Platform.isPad` is iOS-only (undefined on Android), so guard on the OS too.
  const isPad = Platform.OS === 'ios' && Platform.isPad === true;
  const screenLongSide = useMemo(() => {
    const screen = Dimensions.get('screen');
    return Math.max(screen.width, screen.height);
  }, []);
  const wallDeviceClass = resolveWallDeviceClass({ screenLongSide, isPad });
  return useMemo(
    () => ({ ...resolveDeviceLayout({ width, isPad }), isPad, wallDeviceClass }),
    [width, isPad, wallDeviceClass],
  );
}
