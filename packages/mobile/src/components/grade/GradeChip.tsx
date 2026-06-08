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
import { brandColors as staticBrandColors, withAlpha } from '../../theme/colors';
import { spacing } from '../../theme/tokens';
import { readableTextColor } from './grade-chip-colors';

export type GradeChipTone = 'neutral' | 'selected' | 'range' | 'consensus';

type GradeChipProps = {
  label: string;
  tone?: GradeChipTone;
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
  gradeColor,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  onLayout,
  style,
}: GradeChipProps) {
  const { systemColors, brandColors = staticBrandColors } = useTheme();
  const accentColor = gradeColor ?? brandColors.primary;
  const selected = tone === 'selected';
  const ranged = tone === 'range';
  const consensus = tone === 'consensus';

  let backgroundColor: ColorValue = systemColors.fill;
  let borderColor: ColorValue = systemColors.fill;
  let textColor: ColorValue | undefined;

  if (selected) {
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
      rippleColor={accentColor}
      onLayout={onLayout}
      style={[styles.pressable, { backgroundColor, borderColor }, style]}
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
    borderWidth: 1,
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
