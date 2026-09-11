// The pill half of the tap-cycles / hold-reveals pair: a compact readout of a
// number that steps through useful values on tap, and opens the `ValueSlider`
// beneath it on a long press. Apple Podcasts' playback-speed control, which is
// where both of this app's numbers-you-change-mid-session ended up: the play
// drawer's cadence, and the rest timer's rest length.
//
// It holds no value of its own. The owner decides what a tap steps to and what
// the label reads, so the same pill can cycle presets, step a fixed interval, or
// wrap through a mode the slider cannot express.

import { useCallback } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
// Aliased: this file reads scheme-aware brand from `useTheme()` nowhere, because
// the active pill is a FILL with white text and the lifted dark tint would fail
// white-on-fill. `staticBrandColors` is deliberately the static set.
import { brandColors as staticBrandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { springs } from '../theme/animations';
import { borderRadius, spacing } from '../theme/tokens';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type ValuePillProps = {
  /** The current value, already formatted. */
  label: string;
  /** Whether the slider it reveals is open — the pill fills while it is. */
  active: boolean;
  /**
   * Width floor, sized to the LONGEST label this pill can ever show. Required,
   * because the caller is the only one who knows that: get it wrong and stepping
   * the value resizes the pill and walks its whole row sideways.
   */
  minWidth: number;
  /** Drop the press-spring when the OS asks for less motion. */
  reduceMotion?: boolean;
  onCycle: () => void;
  onToggleSlider: () => void;
  accessibilityLabel: string;
  /** Say what a tap does AND what a hold does — a long press is discoverable by
   *  nobody, and by a screen-reader user least of all. */
  accessibilityHint: string;
  testID?: string;
};

export function ValuePill({
  label,
  active,
  minWidth,
  reduceMotion = false,
  onCycle,
  onToggleSlider,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ValuePillProps) {
  const { systemColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePressIn = useCallback(() => {
    if (reduceMotion) return;
    scale.value = withSpring(0.92, springs.snappy);
  }, [reduceMotion, scale]);
  const handlePressOut = useCallback(() => {
    if (reduceMotion) return;
    scale.value = withSpring(1, springs.snappy);
  }, [reduceMotion, scale]);

  return (
    <AnimatedPressable
      onPress={onCycle}
      onLongPress={onToggleSlider}
      delayLongPress={300}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ expanded: active }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={[
        styles.pill,
        { minWidth, backgroundColor: active ? staticBrandColors.primary : systemColors.fill },
        animatedStyle,
      ]}
      testID={testID}
    >
      <Text variant="footnote" color={active ? iosSystemColors.white : systemColors.label} style={styles.pillText}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // Meets the 44dp touch floor on its own rather than only through hitSlop,
    // which left the pill visually shorter than the controls beside it.
    minHeight: 44,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
  pillText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
});
