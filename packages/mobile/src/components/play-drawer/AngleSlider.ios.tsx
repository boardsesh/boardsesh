// AngleSlider — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// A single SwiftUI `Slider` inside its own `Host`, running in the INDEX domain
// (`0..count-1`) with `step={1}` so the thumb hard-snaps to each stop for every
// count — including a 2-angle set (MoonBoard), where iOS snapping works where
// Android's Material steps can't (see AngleSlider.android.tsx). The slider trait,
// VoiceOver adjustable announcement, and increment/decrement come from the
// platform, so the old hand-rolled AccessibilityInfo / reduce-motion plumbing is
// dropped. We only bridge the brand tint via a modifier.
//
// One Host per control is intentional for now (AngleSlider is used one-per-card).

import { Slider } from '@expo/ui/swift-ui';
import { tint, accessibilityValue } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { ThemedHost } from '../ThemedHost';
import { brandAccentColor } from '../../theme/expo-ui-modifiers';
import { makeAngleSliderHandler, sliderIndexForAngle } from './AngleSlider.logic';
import type { AngleSliderProps } from './AngleSlider.types';

export function AngleSlider({ angles, value, onChange }: AngleSliderProps) {
  const { brandColors } = useTheme();
  const count = angles.length;
  // An empty angle set (unknown-board `[] ` fallback) would make a degenerate
  // SwiftUI `Slider(in: 0...0)`. There's nothing to pick, so render nothing.
  if (count === 0) return null;
  const valueIndex = sliderIndexForAngle(angles, value);
  const handleValueChange = makeAngleSliderHandler(angles, valueIndex, onChange);

  return (
    // minHeight floors the row in RN's layout: the native iOS Host (matchContents
    // vertical) under-reports the Slider's height, so without a floor the control
    // collapses and overlaps adjacent content.
    <ThemedHost matchContents={{ vertical: true }} style={[styles.host, styles.minRow]}>
      <Slider
        value={valueIndex}
        min={0}
        // Guard against an empty set (max < min): clamp to 0 so min === max.
        max={Math.max(0, count - 1)}
        // step=1 snaps the thumb to integer stop indices for ALL counts.
        step={1}
        onValueChange={handleValueChange}
        modifiers={[
          // Brand fill tint, sourced once via the theming bridge.
          tint(brandAccentColor(brandColors)),
          // The slider runs in INDEX space, so VoiceOver would otherwise announce
          // the raw index ("1"). Override it with the angle ("40°") — re-applied on
          // each controlled value change, so it re-announces as the user adjusts.
          accessibilityValue(`${value}°`),
        ]}
      />
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
  // iOS slider sits ~30pt; 44 gives a comfortable, non-collapsing row.
  minRow: {
    minHeight: 44,
  },
});
