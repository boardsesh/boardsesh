import { memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { springs } from '../../theme/animations';
import { spacing } from '../../theme/tokens';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// The pill stays its compact size; the touch target grows round it by this much
// on the top and bottom, and the same negative margin gives the room back, so a
// row of chips lays out exactly as the pills alone would. A footnote pill is
// ~34pt tall, so the target reaches 44pt. The overhang reaches into the row gap
// and past the row's edge, which the new architecture still hit-tests.
const TOUCH_OVERHANG = 5;

export type FilterChipProps<Value> = {
  label: string;
  selected: boolean;
  /** Handed back to `onPress`, so a row of chips can share one stable handler. */
  value: Value;
  onPress: (value: Value) => void;
  /** Defaults to `label`. */
  accessibilityLabel?: string;
};

function FilterChipComponent<Value>({ label, selected, value, onPress, accessibilityLabel }: FilterChipProps<Value>) {
  const { systemColors, brandColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Filled rest state (no faint border) so unselected chips are legible on the
  // near-black sheet. Selected is the brand fill with its on-fill label, the one
  // selection tint every control in the app uses.
  const pillFill: ViewStyle = { backgroundColor: selected ? brandColors.primaryFill : systemColors.fill };
  return (
    <AnimatedPressable
      onPress={() => {
        hapticSelection();
        onPress(value);
      }}
      onPressIn={() => {
        scale.value = withSpring(0.95, springs.snappy);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, springs.snappy);
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={[animatedStyle, styles.target]}
    >
      <View style={[styles.pill, pillFill]}>
        <Text variant="footnote" color={selected ? brandColors.onPrimary : undefined} style={styles.label}>
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

/**
 * The one chip of a filter sheet's single-select groups (progress, popularity,
 * sort...). A filled capsule; the selected one takes the brand fill. Memoised:
 * pass a stable `onPress` and let `value` say which chip was tapped.
 */
export const FilterChip = memo(FilterChipComponent) as typeof FilterChipComponent;

/**
 * The wrapping row a group of `FilterChip`s sits in. Only its chips take
 * touches, so a pin target overhanging the row from the label above still works.
 */
export function FilterChipGroup({ children }: { children?: ReactNode }) {
  return (
    <View pointerEvents="box-none" style={styles.group}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  target: {
    paddingVertical: TOUCH_OVERHANG,
    marginVertical: -TOUCH_OVERHANG,
  },
  pill: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
  },
  label: {
    fontWeight: '500',
  },
  group: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
});
