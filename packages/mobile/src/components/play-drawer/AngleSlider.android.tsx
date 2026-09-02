// AngleSlider — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose.
//
// A single Material 3 `Slider` inside its own `Host`, running in the INDEX domain
// (`0..count-1`). The slider trait, TalkBack adjustable announcement, and
// increment/decrement come from the platform, so the old hand-rolled
// AccessibilityInfo / reduce-motion plumbing is dropped. Brand thumb + active
// track colour comes from `sliderBrandColors`; the rest reads the Compose
// Material theme the Host sets up.
//
// One Host per control is intentional for now (AngleSlider is used one-per-card).
//
// Accessibility asymmetry vs iOS: the iOS Slider overrides its announced value
// with the angle via `accessibilityValue("40°")`. The @expo/ui Compose `semantics`
// modifier only exposes `{ contentType }` (no stateDescription/contentDescription),
// so there's no clean way to replace TalkBack's built-in range announcement with
// the angle on Android. TalkBack announces the range position; the visible label
// carries the angle. Revisit if @expo/ui adds a state-description modifier.

import { Slider } from '@expo/ui/jetpack-compose';
import { StyleSheet } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { ThemedHost } from '../ThemedHost';
import { sliderBrandColors } from '../../theme/expo-ui-modifiers';
import { makeAngleSliderHandler, sliderIndexForAngle } from './AngleSlider.logic';
import type { AngleSliderProps } from './AngleSlider.types';

export function AngleSlider({ angles, value, onChange }: AngleSliderProps) {
  const { brandColors } = useTheme();
  const count = angles.length;
  // An empty angle set (unknown-board `[]` fallback) has nothing to pick — render
  // nothing rather than a degenerate Slider. Mirrors the iOS impl.
  if (count === 0) return null;
  const valueIndex = sliderIndexForAngle(angles, value);
  const handleValueChange = makeAngleSliderHandler(angles, valueIndex, onChange);

  // Material counts the steps BETWEEN the endpoints; the endpoints are always
  // selectable, so `count` stop positions => `count - 2` intermediate steps.
  //
  // KNOWN EDGE — `steps={0}` is CONTINUOUS, not "no intermediate stops":
  // Material treats `steps={0}` as infinite steps (no snapping) per the @expo/ui
  // d.ts. So a 2-angle set (MoonBoard `[25, 40]`) => steps = count - 2 = 0 => the
  // thumb slides freely and won't hard-snap to the two stops. The JS handler
  // still rounds to the nearest index and emits a real angle, so the VALUE stays
  // correct (functionally fine) — only the thumb's resting VISUAL can land
  // off-stop on Android. We clamp `steps` to >= 0 and accept the gap; a
  // SegmentedControl fallback for count <= 2 is a possible future refinement
  // (kept a single consistent Slider for now). iOS `step={1}` snaps for count=2.
  const steps = Math.max(0, count - 2);

  return (
    <ThemedHost matchContents={{ vertical: true }} style={styles.host}>
      <Slider
        value={valueIndex}
        min={0}
        // Guard against an empty set (max < min): clamp to 0 so min === max.
        max={Math.max(0, count - 1)}
        steps={steps}
        onValueChange={handleValueChange}
        colors={sliderBrandColors(brandColors)}
      />
    </ThemedHost>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});
