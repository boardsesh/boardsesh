// AngleSlider — Android implementation, real Jetpack Compose via
// @expo/ui/jetpack-compose.
//
// A single Material 3 `Slider` inside its own `Host`, running in the INDEX domain
// (`0..count-1`). The slider trait, TalkBack adjustable announcement, and
// increment/decrement come from the platform, so the old hand-rolled
// AccessibilityInfo / reduce-motion plumbing is dropped. Brand thumb + active
// track colour comes from `sliderControlColors`; the rest reads the Compose
// Material theme the Host sets up.
//
// One Host per control is intentional for now (AngleSlider is used one-per-card).
//
// The slider runs in INDEX space, so TalkBack's own range announcement is a
// position, not an angle. A `semantics({ contentDescription })` modifier puts
// the angle ("Angle, 40°") in front of it, the nearest Compose gets to the iOS
// `accessibilityValue` override; @expo/ui exposes no stateDescription.

import { ComposeHost } from '../ComposeHost.android';
import { Slider } from '@expo/ui/jetpack-compose';
import { semantics } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { sliderControlColors } from '../../theme/expo-ui-modifiers';
import { makeAngleSliderHandler, sliderIndexForAngle } from './AngleSlider.logic';
import type { AngleSliderProps } from './AngleSlider.types';

export function AngleSlider({ angles, value, onChange, accessibilityLabel }: AngleSliderProps) {
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
  // off-stop on Android. We clamp `steps` to >= 0 and accept the gap here. The
  // tick sheets' TickAngleControl swaps in a SegmentedControl for 2 stops; the
  // other callers keep one consistent Slider. iOS `step={1}` snaps for count=2.
  const steps = Math.max(0, count - 2);
  // The same `40°` string iOS speaks, behind the label when there is one.
  const contentDescription = accessibilityLabel ? `${accessibilityLabel}, ${value}°` : `${value}°`;

  return (
    <ComposeHost matchContents={{ vertical: true }} style={styles.host}>
      <Slider
        value={valueIndex}
        min={0}
        // Guard against an empty set (max < min): clamp to 0 so min === max.
        max={Math.max(0, count - 1)}
        steps={steps}
        onValueChange={handleValueChange}
        // The control tint, not the fill — see `brandControlTint`: the dark-mode
        // fill is under 3:1 on the card this slider sits on.
        colors={sliderControlColors(brandColors)}
        modifiers={[semantics({ contentDescription })]}
      />
    </ComposeHost>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});
