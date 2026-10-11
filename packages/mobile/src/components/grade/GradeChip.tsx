import {
  StyleSheet,
  View,
  useWindowDimensions,
  type AccessibilityState,
  type ColorValue,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
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
 *   grade's colour and a state mark in front of its label. At rest the colour is a
 *   dot on a neutral fill; a selected grade is the solid colour, so a selected V6
 *   is the same red it is everywhere else in the app. A checkmark takes the dot's
 *   place on every chip that is part of the selection, so the state never rests on
 *   colour alone.
 * - `selection`: the chip carries SELECTION state instead of grade identity —
 *   violet for "your choice", an amber ring for "the crowd's". Used by the tick
 *   sheets, where the grade ramp lives in the header's identity bar and the rail
 *   only has to answer "which one did I pick?".
 */
export type GradeChipColorway = 'grade' | 'selection';

// The `grade` colorway's state mark. The slot is the checkmark's point size and
// the dot sits centred in it.
const MARK_SLOT_SIZE = 12;
const MARK_DOT_SIZE = 8;
// `Icon`'s own default cap, restated so the slot scales exactly as the glyph in
// it does.
const MARK_MAX_FONT_SCALE = 1.5;

export type GradeChipProps = {
  label: string;
  tone?: GradeChipTone;
  colorway?: GradeChipColorway;
  /** The grade's colour. A `grade`-colorway chip that stands for no grade (the
   *  range rail's "Any") leaves it out and gets no dot. */
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
  const marked = colorway === 'grade';

  // Neutral, in both colorways: a filled pill with no live edge. The border is
  // transparent rather than the fill colour so a 1pt ring can't read as an
  // affordance the chip doesn't have. An in-range `grade` chip keeps this fill
  // too: its checkmark says "between the ends", and a tint or a coloured ring
  // there would compete with the two solid ends.
  let backgroundColor: ColorValue = systemColors.fill;
  let borderColor: ColorValue = 'transparent';
  let borderWidth = 1;
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
    backgroundColor = accentColor;
    borderColor = accentColor;
    textColor = readableTextColor(accentColor);
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
      <View style={marked ? [styles.content, styles.markedContent] : styles.content}>
        {marked ? (
          <GradeChipMark
            checked={selected || ranged}
            dotColor={gradeColor}
            checkColor={textColor ?? systemColors.label}
          />
        ) : null}
        <Text variant="footnote" color={textColor} numberOfLines={1} style={styles.label}>
          {label}
        </Text>
      </View>
    </PressableSurface>
  );
}

type GradeChipMarkProps = {
  /** The chip is part of the selection: draw the checkmark, not the dot. */
  checked: boolean;
  dotColor: string | undefined;
  checkColor: ColorValue;
};

/**
 * The state mark in front of a `grade`-colorway label: the grade's colour as a
 * dot, or a checkmark once the chip is part of the selection. Both sit in one
 * slot of a set size, so the label does not move when a chip changes state. A
 * chip with neither (the range rail's "Any" while a filter is set) keeps the
 * empty slot for the same reason, the way a menu keeps its checkmark column.
 */
function GradeChipMark({ checked, dotColor, checkColor }: GradeChipMarkProps) {
  const { systemColors } = useTheme();
  const { fontScale } = useWindowDimensions();
  // Grows with the label beside it, the way `Icon` scales its own glyph.
  const markScale = Math.min(fontScale, MARK_MAX_FONT_SCALE);
  const slotSize = MARK_SLOT_SIZE * markScale;
  const dotSize = MARK_DOT_SIZE * markScale;

  return (
    <View style={[styles.markSlot, { width: slotSize, height: slotSize }]}>
      {checked ? (
        <Icon
          name="check.small"
          size={MARK_SLOT_SIZE}
          maxFontSizeMultiplier={MARK_MAX_FONT_SCALE}
          weight="semibold"
          color={checkColor}
        />
      ) : dotColor ? (
        // The separator ring keeps a pale grade colour visible on the pale fill.
        <View
          style={[
            styles.markDot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: dotColor,
              borderColor: systemColors.separator,
            },
          ]}
        />
      ) : null}
    </View>
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
  // `grade` colorway only: the mark sits in front of the label.
  markedContent: {
    flexDirection: 'row',
    gap: spacing[1],
  },
  markSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  markDot: {
    borderWidth: 1,
  },
  label: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
