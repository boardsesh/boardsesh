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
 *   grade ramp. At rest it is a neutral pill. A selected grade is the solid
 *   colour, so a selected V6 is the same red it is everywhere else in the app,
 *   and a chip inside a range is a wash of its own grade colour with a coloured
 *   ring. Each state has its own fill and its own border, so none of them rests
 *   on hue alone.
 * - `selection`: the chip carries SELECTION state instead of grade identity —
 *   violet for "your choice", an amber ring for "the crowd's". Used by the tick
 *   sheets, where the grade ramp lives in the header's identity bar and the rail
 *   only has to answer "which one did I pick?".
 */
export type GradeChipColorway = 'grade' | 'selection';

/**
 * The chip's visual height. The chip and the range rail's row both size from
 * this one number, so a different height is a one-line change.
 */
export const GRADE_CHIP_HEIGHT = 44;

// The chip's border. Every `grade` tone keeps this width, so none of them
// resizes the box; the `selection` colorway's 2pt consensus ring is the one
// deliberate exception.
const CHIP_BORDER_WIDTH = 1;
// The ring round a selected `grade` chip: the label colour at just under half
// strength, so a dark grade colour still has an edge on a dark background.
const SELECTED_RING_ALPHA = 0.45;

export type GradeChipProps = {
  label: string;
  tone?: GradeChipTone;
  colorway?: GradeChipColorway;
  /** The grade's colour. A `grade`-colorway chip that stands for no grade (the
   *  range rail's "Any") leaves it out: selected, it keeps the neutral fill and
   *  takes only the ring. */
  gradeColor?: string;
  onPress: () => void;
  /** Touch and hold. The release after it does not also fire `onPress`. */
  onLongPress?: () => void;
  delayLongPress?: number;
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
  onLongPress,
  delayLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  onLayout,
  style,
}: GradeChipProps) {
  const { systemColors, brandColors, chartColors } = useTheme();
  const accentColor = gradeColor ?? brandColors.primary;
  const selected = tone === 'selected';
  const ranged = tone === 'range';
  const consensus = tone === 'consensus';

  // Neutral, in both colorways: a filled pill with no live edge. The border is
  // transparent rather than the fill colour so a 1pt ring can't read as an
  // affordance the chip doesn't have.
  let backgroundColor: ColorValue = systemColors.fill;
  let borderColor: ColorValue = 'transparent';
  let borderWidth = CHIP_BORDER_WIDTH;
  let textColor: ColorValue | undefined;

  if (colorway === 'selection') {
    textColor = systemColors.label;
    if (selected) {
      backgroundColor = brandColors.primaryFill;
      // The ring stays 1pt and matches the fill, so it is invisible but keeps the
      // box geometry identical to the neutral tone. React Native is border-box:
      // dropping to 0 here grew the inner content box by 2pt and nudged the label
      // every time a chip went from unselected to selected.
      borderColor = brandColors.primaryFill;
      textColor = brandColors.onPrimary;
    } else if (consensus) {
      borderColor = brandColors.warning;
      borderWidth = 2;
    }
  } else if (selected) {
    // The ring is the border every tone already has, in another colour, so a
    // selected chip is the same size as its neighbours. `chartColors` is the
    // theme's plain-string palette: `withAlpha` reads hex, and
    // `systemColors.label` is a `PlatformColor` on iOS.
    borderColor = withAlpha(chartColors.label, SELECTED_RING_ALPHA);
    // With no grade colour (the range rail's "Any") the ring is the whole
    // selected state: the fill stays neutral, never a brand colour.
    if (gradeColor) {
      backgroundColor = gradeColor;
      textColor = readableTextColor(gradeColor);
    }
  } else if (ranged && gradeColor) {
    backgroundColor = withAlpha(gradeColor, 0.18);
    borderColor = withAlpha(gradeColor, 0.75);
  } else if (consensus) {
    backgroundColor = withAlpha(accentColor, 0.11);
    borderColor = withAlpha(accentColor, 0.55);
  }

  return (
    <PressableSurface
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
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
    minHeight: GRADE_CHIP_HEIGHT,
    minWidth: 52,
    borderRadius: GRADE_CHIP_HEIGHT / 2,
    justifyContent: 'center',
  },
  content: {
    // The box inside the pressable's top and bottom borders.
    minHeight: GRADE_CHIP_HEIGHT - CHIP_BORDER_WIDTH * 2,
    paddingHorizontal: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
