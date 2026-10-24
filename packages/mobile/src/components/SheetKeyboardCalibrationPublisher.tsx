import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFeatureFlag } from '../providers/feature-flags-provider';
import { publishSheetKeyboardCalibration } from '../lib/sheet-keyboard-calibration-store';

/**
 * Mount ONCE in the root layout, inside `FeatureFlagsProvider` and outside the
 * (tabs) subtree, where `useSafeAreaInsets()` is the window's. Publishes the
 * `sheet-keyboard-calibration` flag for `Sheet` / `ModalSheet` (see
 * `sheet-keyboard-calibration-store`). iOS only: the readout calibrates the iOS
 * sheet keyboard padding (#5964), and its window-origin probe is SwiftUI.
 * Renders nothing.
 */
export function SheetKeyboardCalibrationPublisher() {
  const flagOn = useFeatureFlag('sheet-keyboard-calibration') === true;
  const { top } = useSafeAreaInsets();
  const enabled = flagOn && Platform.OS === 'ios';
  useEffect(() => {
    publishSheetKeyboardCalibration({ enabled, windowTopInset: top });
  }, [enabled, top]);
  return null;
}
