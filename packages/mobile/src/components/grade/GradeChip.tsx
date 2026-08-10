import {
  StyleSheet,
  View,
  type AccessibilityState,
  type ColorValue,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { spacing } from '../../theme/tokens';
import { readableTextColor } from './grade-chip-colors';

export type GradeChipTone = 'neutral' | 'selected' | 'range' | 'consensus';

/**
 * Which palette the chip paints itself from.
 *
 * - `grade` (the default, and what every filter rail uses): the chip carries the
 *   grade ramp, so a selected V6 is the same red it is everywhere else in the app.
 * - `selection`: the chip carries SELECTION state instead of grade identity —
 *   violet for "your choice", an amber ring for "the crowd's". Used by the tick
 *   sheets, where the grade ramp lives in the header's identity bar and the rail
 *   only has to answer "which one did I pick?".
 */
export type GradeChipColorway = 'grade' | 'selection';

export type GradeChipProps = {
  label: string;
  tone?: GradeChipTone;
  colorway?: GradeChipColorway;
  gradeColor?: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  onLayout?: (event: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

export function GradeChip({
  label,
  tone = 'neutral',
  colorway = 'grade',
  gradeColor,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  onLayout,
  style,
}: GradeChipProps) {
  const { systemColors, brandColors } = useTheme();
  const accentColor = gradeColor ?? brandColors.primary;
  const selected = tone === 'selected';
  const ranged = tone === 'range';
  const consensus = tone === 'consensus';

  // Neutral, in both colorways: a filled pill with no live edge. The border is
  // transparent rather than the fill colour so a 1pt ring can't read as an
  // affordance the chip doesn't have.
  let backgroundColor: ColorValue = systemColors.fill;
  let borderColor: ColorValue = 'transparent';
  let borderWidth = 1;
  let textColor: ColorValue | undefined;

  if (colorway === 'selection') {
    textColor = systemColors.label;
    if (selected) {
      backgroundColor = brandColors.primaryFill;
      borderColor = brandColors.primaryFill;
      borderWidth = 0;
      textColor = brandColors.onPrimary;
    } else if (consensus) {
      borderColor = brandColors.warning;
      borderWidth = 2;
    }
  } else if (selected) {
    backgroundColor = accentColor;
    borderColor = accentColor;
    textColor = readableTextColor(accentColor);
  } else if (ranged) {
    backgroundColor = withAlpha(accentColor, 0.18);
    borderColor = withAlpha(accentColor, 0.75);
  } else if (consensus) {
    backgroundColor = withAlpha(accentColor, 0.11);
    borderColor = withAlpha(accentColor, 0.55);
  }

  return (
    <PressableSurface
      onPress={onPress}
      feedback="scale"
      scaleTo={0.94}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState}
      rippleColor={colorway === 'selection' ? brandColors.primary : accentColor}
      onLayout={onLayout}
      style={[styles.pressable, { backgroundColor, borderColor, borderWidth }, style]}
    >
      <View style={styles.content}>
        <Text variant="footnote" color={textColor} numberOfLines={1} style={styles.label}>
          {label}
        </Text>
      </View>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  pressable: {
    minHeight: 44,
    minWidth: 52,
    borderRadius: 22,
    justifyContent: 'center',
  },
  content: {
    minHeight: 42,
    paddingHorizontal: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
