// Controls the workout block cards and the climb filters share: the filled
// chip, the grouped stepper card, the per-type count steppers and the grade
// helpers.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type Insets, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Chip as PaperChip } from 'react-native-paper';
import type { BoardName, Grade } from '@boardsesh/shared-schema';
import { getGradesForBoard } from '@boardsesh/board-config';
import type { GeneratorOptions } from '@boardsesh/playlist-generator';
import { Stepper } from '../../Stepper';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { createVariantComponent, selectByVariant } from '../../../theme/variants';
import { hapticSelection } from '../../../lib/haptics';
import { spacing, borderRadius } from '../../../theme/tokens';
import { springs } from '../../../theme/animations';
// Aliased: the selected chip is a FILL with white text that must stay legible in
// both schemes, so it reads the static brand set (mirrors ClimbFilterSheet).
import { brandColors as staticBrandColors } from '../../../theme/colors';
import { iosSystemColors } from '../../../theme/ios-colors';

type Translate = (key: string) => string;

export function getDefaultTargetGrade(boardName: BoardName | null): number {
  if (!boardName) return 15;
  const grades = getGradesForBoard(boardName);
  if (grades.length === 0) return 15;
  return grades[Math.floor(grades.length / 2)].difficulty_id;
}

// Map the board-config grade table (snake_case BoulderGrade) onto the GraphQL
// Grade shape GradeSingleSelectRail consumes.
export function toRailGrades(boardName: BoardName | null): Grade[] {
  if (!boardName) return [];
  return getGradesForBoard(boardName).map((grade) => ({
    difficultyId: grade.difficulty_id,
    name: grade.difficulty_name,
  }));
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type ChipProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  /** Grows the touch target past the drawn pill, e.g. to 44pt in a dense row. */
  hitSlop?: Insets;
};

// Filled-rest-state chip (no faint border), matching the ClimbFilterSheet
// `Chip`: the selected chip is a static-brand FILL with white text; the rest
// state is the system fill so unselected chips stay legible. On Material it
// routes to the Paper M3 filter chip (secondaryContainer + checkmark when
// selected) so it reads as a native M3 filter chip rather than an iOS pill.
// Split into two sub-components (rather than an early return) so the glass
// branch's reanimated hooks stay unconditional across a runtime variant flip.
export const Chip = createVariantComponent('Chip', { liquidGlass: ChipGlass, material: ChipMaterial });

function ChipMaterial({ label, selected, onPress, accessibilityLabel, hitSlop }: ChipProps) {
  return (
    <PaperChip
      mode="flat"
      selected={selected}
      showSelectedCheck
      hitSlop={hitSlop}
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {label}
    </PaperChip>
  );
}

function ChipGlass({ label, selected, onPress, accessibilityLabel, hitSlop }: ChipProps) {
  const { systemColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const chipStyle: ViewStyle = {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
    backgroundColor: selected ? staticBrandColors.primary : systemColors.fill,
  };
  return (
    <AnimatedPressable
      onPress={() => {
        hapticSelection();
        onPress();
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
      hitSlop={hitSlop}
      style={[animatedStyle, chipStyle]}
    >
      <Text
        variant="footnote"
        color={selected ? iosSystemColors.white : undefined}
        style={generatorControlStyles.chipText}
      >
        {label}
      </Text>
    </AnimatedPressable>
  );
}

export type StepperRow = { key: string; node: ReactNode };

// A grouped iOS inset card of stepper rows (label left, value + −/+ trailing),
// hairline-divided between rows, matching the ClimbFilterSheet groupedCard
// pattern. Rows carry stable keys (the option field name), so no index keys.
export function GroupedSteppers({ rows }: { rows: StepperRow[] }) {
  const { systemColors, variant, m3 } = useTheme();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  // Material: a filled tonal card (surfaceVariant) with outlineVariant dividers,
  // instead of the iOS `systemColors.fill` inset-table look.
  return (
    <View
      style={[
        generatorControlStyles.groupedCard,
        { backgroundColor: isMaterial ? m3.surfaceVariant : systemColors.fill },
      ]}
    >
      {rows.map((row, index) => (
        <View key={row.key}>
          {index > 0 ? (
            <View
              style={[
                generatorControlStyles.groupDivider,
                { backgroundColor: isMaterial ? m3.outlineVariant : systemColors.separator },
              ]}
            />
          ) : null}
          {row.node}
        </View>
      ))}
    </View>
  );
}

function stepperRow(
  label: string,
  fieldKey: string,
  value: number,
  min: number,
  max: number,
  onValue: (next: number) => void,
): StepperRow {
  return { key: fieldKey, node: <Stepper label={label} value={value} min={min} max={max} onChange={onValue} /> };
}

/**
 * The count steppers for one workout: the primary count (volume's main-set
 * climbs, pyramid/ladder's steps, grade focus's climbs) then each shape's
 * secondary knob (volume's grade spread, pyramid/ladder's climbs per step).
 * Labels are literal `t()` keys so the i18n key analyser sees each one.
 */
export function workoutStepperRows(
  options: GeneratorOptions,
  t: Translate,
  onOptionsChange: (options: GeneratorOptions) => void,
): StepperRow[] {
  switch (options.type) {
    case 'volume':
      return [
        stepperRow(
          t('mobile.session.preGeneratorMainSetClimbs'),
          'mainSetClimbs',
          options.mainSetClimbs,
          1,
          50,
          (mainSetClimbs) => onOptionsChange({ ...options, mainSetClimbs }),
        ),
        stepperRow(
          t('mobile.session.preGeneratorMainSetVariability'),
          'mainSetVariability',
          options.mainSetVariability,
          0,
          5,
          (mainSetVariability) => onOptionsChange({ ...options, mainSetVariability }),
        ),
      ];
    case 'pyramid':
    case 'ladder':
      return [
        stepperRow(
          t('mobile.session.preGeneratorNumberOfSteps'),
          'numberOfSteps',
          options.numberOfSteps,
          3,
          15,
          (numberOfSteps) => onOptionsChange({ ...options, numberOfSteps }),
        ),
        stepperRow(
          t('mobile.session.preGeneratorClimbsPerStep'),
          'climbsPerStep',
          options.climbsPerStep,
          1,
          5,
          (climbsPerStep) => onOptionsChange({ ...options, climbsPerStep }),
        ),
      ];
    case 'gradeFocus':
      return [
        stepperRow(
          t('mobile.session.preGeneratorNumberOfClimbs'),
          'numberOfClimbs',
          options.numberOfClimbs,
          1,
          50,
          (numberOfClimbs) => onOptionsChange({ ...options, numberOfClimbs }),
        ),
      ];
  }
}

export const generatorControlStyles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  chipText: {
    fontWeight: '500',
  },
  groupedCard: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  groupDivider: {
    height: StyleSheet.hairlineWidth,
    marginStart: spacing[4],
  },
});
