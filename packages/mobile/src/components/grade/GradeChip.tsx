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

/**
 * The chip's visual height. The chip, the range rail's row and its Range button
 * all size from this one number, so a different height is a one-line change.
 */
export const GRADE_CHIP_HEIGHT = 44;

// The chip's border. Every `grade` tone keeps this width, so none of them
// resizes the box; the `selection` colorway's 2pt consensus ring is the one
// deliberate exception.
const CHIP_BORDER_WIDTH = 1;
// The `grade` colorway's state mark. The slot is the checkmark's point size and
// the dot sits centred in it.
const MARK_SLOT_SIZE = 12;
const MARK_DOT_SIZE = 10;
// `Icon`'s own default cap, restated so the slot scales exactly as the glyph in
// it does.
const MARK_MAX_FONT_SCALE = 1.5;
// The ring round a grade colour, on the dot and on a selected chip: the label
// colour at just under half strength. A pale grade colour needs it against a
// pale fill, and a dark one needs it against a dark background.
const GRADE_RING_ALPHA = 0.45;

/** The ring colour, from the theme's plain-string palette (`chartColors`):
 *  `withAlpha` reads hex, and `systemColors.label` is a `PlatformColor` on iOS. */
function gradeRingColor(plainColors: { label: string }): string {
  return withAlpha(plainColors.label, GRADE_RING_ALPHA);
}

export type GradeChipProps = {
  label: string;
  tone?: GradeChipTone;
  colorway?: GradeChipColorway;
  /** The grade's colour. A `grade`-colorway chip that stands for no grade (the
   *  range rail's "Any") leaves it out and gets no dot. */
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
  const marked = colorway === 'grade';

  // Neutral, in both colorways: a filled pill with no live edge. The border is
  // transparent rather than the fill colour so a 1pt ring can't read as an
  // affordance the chip doesn't have. An in-range `grade` chip keeps this fill
  // too: its checkmark says "between the ends", and a tint or a coloured ring
  // there would compete with the two solid ends.
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
    backgroundColor = accentColor;
    // The ring is the border every tone already has, in another colour, so a
    // selected chip is the same size as its neighbours.
    borderColor = gradeRingColor(chartColors);
    textColor = readableTextColor(accentColor);
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
      <View style={marked ? [styles.content, styles.markedContent] : styles.content}>
        {marked ? (
          <GradeChipMark
            checked={selected || ranged}
            dotColor={gradeColor}
            checkColor={textColor ?? systemColors.label}
          />
        ) : null}
        <GradeChipLabel color={textColor}>{label}</GradeChipLabel>
      </View>
    </PressableSurface>
  );
}

/** The chip's label type: footnote, semibold, digits that do not jitter. */
export function GradeChipLabel({ color, children }: { color?: ColorValue; children: string }) {
  return (
    <Text variant="footnote" color={color} numberOfLines={1} style={styles.label}>
      {children}
    </Text>
  );
}

type GradeChipMarkProps = {
  /** The chip is part of the selection: draw the checkmark, not the dot. */
  checked: boolean;
  /** The grade's colour, or nothing for a chip that stands for no grade. */
  dotColor?: string;
  checkColor: ColorValue;
};

/**
 * The state mark in front of a `grade`-colorway label: the grade's colour as a
 * dot, or a checkmark once the chip is part of the selection. Both sit in one
 * slot of a set size, so the label does not move when a chip changes state. A
 * chip with neither (the range rail's "Any" while a filter is set, its Range
 * button while it is off) keeps the empty slot for the same reason, the way a
 * menu keeps its checkmark column.
 */
export function GradeChipMark({ checked, dotColor, checkColor }: GradeChipMarkProps) {
  const { chartColors } = useTheme();
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
        <View
          style={[
            styles.markDot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: dotColor,
              borderColor: gradeRingColor(chartColors),
            },
          ]}
        />
      ) : null}
    </View>
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
    borderWidth: CHIP_BORDER_WIDTH,
  },
  label: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
