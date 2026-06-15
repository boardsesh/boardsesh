import { useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { resolveDeviceLayout, type DeviceLayout } from '../theme/size-class';

/**
 * The adaptive shell's size class, recomputed as the app window resizes —
 * rotation, Stage Manager, Split View / Slide Over. iPhone is always `compact`;
 * an iPad is `regular` once its window is wide enough for the sidebar plus a
 * content pane, and falls back to `compact` (the phone UI verbatim) in a narrow
 * split. The arithmetic lives in the pure `resolveDeviceLayout` so it is
 * unit-tested without react-native.
 */
export function useDeviceLayout(): DeviceLayout {
  const { width } = useWindowDimensions();
  // `Platform.isPad` is iOS-only (undefined on Android), so guard on the OS too.
  const isPad = Platform.OS === 'ios' && Platform.isPad === true;
  return useMemo(() => resolveDeviceLayout({ width, isPad }), [width, isPad]);
}
