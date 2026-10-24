import { forwardRef, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Host, Spacer } from '@expo/ui/swift-ui';
import { onGeometryChange } from '@expo/ui/swift-ui/modifiers';
import type { SheetWindowOriginProbeProps } from './sheet-window-origin-probe.types';

/**
 * Calibration-only (#5964): a tiny SwiftUI `Host` that reports where SwiftUI
 * says it sits, through `@expo/ui`'s `onGeometryChange` (`frame(in: .global)`).
 *
 * `measureInWindow` cannot answer that inside an `@expo/ui` sheet: the sheet's
 * `RNHostView` is a layout root, so every shadow-tree measurement stops there
 * and comes back relative to the sheet. Whether `.global` is the window for
 * this nested hosting controller (each `Host` is its own
 * `UIHostingController`) is exactly what the calibration readout is for, so
 * nothing reads this value except that readout.
 *
 * SwiftUI may not report again when only a UIKit ancestor moves (the sheet
 * rising for the keyboard), so the readout remounts this probe with a new `key`
 * whenever it re-measures; a fresh Host reports its initial frame.
 */
export const SheetWindowOriginProbe = forwardRef<View, SheetWindowOriginProbeProps>(function SheetWindowOriginProbe(
  { onFrame, style },
  ref,
) {
  const modifiers = useMemo(() => [onGeometryChange(onFrame)], [onFrame]);
  return (
    <View ref={ref} collapsable={false} pointerEvents="none" style={style}>
      <Host ignoreSafeArea="all" style={StyleSheet.absoluteFill} modifiers={modifiers}>
        <Spacer />
      </Host>
    </View>
  );
});
