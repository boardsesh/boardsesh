import { forwardRef } from 'react';
import type { View } from 'react-native';
import type { SheetWindowOriginProbeProps } from './sheet-window-origin-probe.types';

/**
 * Android / web: no SwiftUI, so no `.global` frame to report. The calibration
 * readout is iOS-only anyway (see `SheetKeyboardCalibrationPublisher`). The iOS
 * probe is `sheet-window-origin-probe.ios.tsx`.
 */
export const SheetWindowOriginProbe = forwardRef<View, SheetWindowOriginProbeProps>(function SheetWindowOriginProbe() {
  return null;
});
