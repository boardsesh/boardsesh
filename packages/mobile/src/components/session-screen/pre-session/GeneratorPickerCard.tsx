import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Chip as PaperChip } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import type { BoardName, Grade } from '@boardsesh/shared-schema';
import { getGradesForBoard } from '@boardsesh/board-config';
import {
  KILTER_HOMEWALL_LAYOUT_ID,
  isKilterHomewallTallSizeId,
  isKilterHomewallWideSizeId,
} from '@boardsesh/board-constants';
import {
  formatMinAscentsFilterCount,
  getMinAscentsFilterOptions,
  getMinRatingPickerValue,
} from '@boardsesh/climb-filters';
import {
  CLIMB_BIAS_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_PYRAMID_OPTIONS,
  DEFAULT_VOLUME_OPTIONS,
  WARM_UP_OPTIONS,
  generateWorkoutPlan,
  type ClimbBias,
  type GeneratorOptions,
  type WarmUpType,
  type WorkoutType,
} from '@boardsesh/playlist-generator';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../../lib/analytics';
import { SectionHeader } from '../../SectionHeader';
import { SegmentedControl } from '../../SegmentedControl';
import { CollapsibleSection } from '../../CollapsibleSection';
import { StarRating } from '../../StarRating';
import { SwitchRow } from '../../SwitchRow';
import { Stepper } from '../../Stepper';
import { Text } from '../../Text';
import { GradeSingleSelectRail } from '../../grade';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useTheme } from '../../../providers/theme-provider';
import { createVariantComponent, selectByVariant } from '../../../theme/variants';
import { hapticSelection } from '../../../lib/haptics';
import { spacing, borderRadius } from '../../../theme/tokens';
import { springs } from '../../../theme/animations';
// Aliased: the selected chip is a FILL with white text that must stay legible in
// both schemes, so it reads the static brand set (mirrors ClimbFilterSheet).
import { brandColors as staticBrandColors } from '../../../theme/colors';
import { iosSystemColors } from '../../../theme/ios-colors';
import type { ColoredBar } from '../../you/profile-chart-colors';
import { WorkoutTypeShelf, type WorkoutTypeShelfItem } from './WorkoutTypeShelf';
import { buildWorkoutGradeBars, buildWorkoutProgressionBars } from './workout-type-shelf-data';

export type GeneratorSelection = { type: 'off' } | { type: 'on'; options: GeneratorOptions };

type GeneratorPickerCardProps = {
  boardName: BoardName | null;
  layoutId: number | null;
  sizeId: number | null;
  /** Board angle, forwarded to the `Workout Generator Opened` event to match web. */
  angle: number | null;
  selection: GeneratorSelection;
  onChange: (selection: GeneratorSelection) => void;
};

type ChipValue = WorkoutType | 'off';
type CommonGeneratorPatch = Partial<
  Pick<
    GeneratorOptions,
    'warmUp' | 'targetGrade' | 'climbBias' | 'minAscents' | 'minRating' | 'onlyTallClimbs' | 'onlyWideClimbs'
  >
>;

// Static value list — the labels are looked up via inline `t('mobile.session.preGenerator…')`
// calls in `chipLabel()` so the i18n key analyser can see every key as a
// literal. Adding a new entry requires adding both a value here and a case in
// `chipLabel`.
const CHIP_VALUES: ChipValue[] = ['off', 'volume', 'pyramid', 'ladder', 'gradeFocus'];

function chipLabel(value: ChipValue, t: (key: string) => string): string {
  switch (value) {
    case 'off':
      return t('mobile.session.preGeneratorOff');
    case 'volume':
      return t('mobile.session.preGeneratorVolume');
    case 'pyramid':
      return t('mobile.session.preGeneratorPyramid');
    case 'ladder':
      return t('mobile.session.preGeneratorLadder');
    case 'gradeFocus':
      return t('mobile.session.preGeneratorGradeFocus');
  }
}

function warmUpLabel(value: WarmUpType, t: (key: string) => string): string {
  switch (value) {
    case 'standard':
      return t('mobile.session.preGeneratorWarmUpStandard');
    case 'extended':
      return t('mobile.session.preGeneratorWarmUpExtended');
    case 'none':
      return t('mobile.session.preGeneratorWarmUpNone');
  }
}

function climbBiasLabel(value: ClimbBias, t: (key: string) => string): string {
  switch (value) {
    case 'unfamiliar':
      return t('mobile.session.preGeneratorClimbBiasUnfamiliar');
    case 'attempted':
      return t('mobile.session.preGeneratorClimbBiasAttempted');
    case 'any':
      return t('mobile.session.preGeneratorClimbBiasAny');
  }
}

function buildDefaultOptions(type: WorkoutType, targetGrade: number): GeneratorOptions {
  switch (type) {
    case 'volume':
      return { ...DEFAULT_VOLUME_OPTIONS, targetGrade };
    case 'pyramid':
      return { ...DEFAULT_PYRAMID_OPTIONS, targetGrade };
    case 'ladder':
      return { ...DEFAULT_LADDER_OPTIONS, targetGrade };
    case 'gradeFocus':
      return { ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade };
  }
}

function getDefaultTargetGrade(boardName: BoardName | null): number {
  if (!boardName) return 15;
  const grades = getGradesForBoard(boardName);
  if (grades.length === 0) return 15;
  return grades[Math.floor(grades.length / 2)].difficulty_id;
}

function getChartClimbCount(bar: ColoredBar): number {
  return bar.segments.reduce((total, segment) => total + segment.value, 0);
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type ChipProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
};

// Filled-rest-state chip (no faint border), matching the ClimbFilterSheet
// `Chip`: the selected chip is a static-brand FILL with white text; the rest
// state is the system fill so unselected chips stay legible. On Material it
// routes to the Paper M3 filter chip (secondaryContainer + checkmark when
// selected) so it reads as a native M3 filter chip rather than an iOS pill.
// Split into two sub-components (rather than an early return) so the glass
// branch's reanimated hooks stay unconditional across a runtime variant flip.
const Chip = createVariantComponent('Chip', { liquidGlass: ChipGlass, material: ChipMaterial });

function ChipMaterial({ label, selected, onPress, accessibilityLabel }: ChipProps) {
  return (
    <PaperChip
      mode="flat"
      selected={selected}
      showSelectedCheck
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

function ChipGlass({ label, selected, onPress, accessibilityLabel }: ChipProps) {
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
      style={[animatedStyle, chipStyle]}
    >
      <Text variant="footnote" color={selected ? iosSystemColors.white : undefined} style={styles.chipText}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

type StepperRow = { key: string; node: ReactNode };

// A grouped iOS inset card of stepper rows (label left, value + −/+ trailing),
// hairline-divided between rows, matching the ClimbFilterSheet groupedCard
// pattern. Rows carry stable keys (the option field name), so no index keys.
function GroupedSteppers({ rows }: { rows: StepperRow[] }) {
  const { systemColors, variant, m3 } = useTheme();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  // Material: a filled tonal card (surfaceVariant) with outlineVariant dividers,
  // instead of the iOS `${systemGray}14` inset-table look.
  return (
    <View style={[styles.groupedCard, isMaterial && { backgroundColor: m3.surfaceVariant }]}>
      {rows.map((row, index) => (
        <View key={row.key}>
          {index > 0 ? (
            <View
              style={[
                styles.groupDivider,
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

// Map the board-config grade table (snake_case BoulderGrade) onto the GraphQL
// Grade shape GradeSingleSelectRail consumes.
function toRailGrades(boardName: BoardName | null): Grade[] {
  if (!boardName) return [];
  return getGradesForBoard(boardName).map((grade) => ({
    difficultyId: grade.difficulty_id,
    name: grade.difficulty_name,
  }));
}

/**
 * Workout-type selector. Off keeps the queue empty (user fills it manually);
 * any other choice pre-populates the queue from the shared `@boardsesh/playlist-generator`
 * algorithm and the chosen target grade. Defaults come from the shared package
 * so web and mobile agree on the starting state for each workout type.
 *
 * Laid out as iOS grouped inset sections (mirroring ClimbFilterSheet): a
 * filled-chip workout-type rail, a single-select grade rail, a grouped stepper
 * card for the primary count(s), and a collapsed "Tuning" section for the long
 * tail (min-ascents, min-rating, climb bias, tall/wide).
 */
export function GeneratorPickerCard({
  boardName,
  layoutId,
  sizeId,
  angle,
  selection,
  onChange,
}: GeneratorPickerCardProps) {
  const { t } = useTranslation('session');
  const { systemColors, variant, m3 } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });

  const isKilterHomewall = boardName === 'kilter' && layoutId === KILTER_HOMEWALL_LAYOUT_ID;
  const showTallClimbsFilter = isKilterHomewall && sizeId != null && isKilterHomewallTallSizeId(sizeId);
  const showWideClimbsFilter = isKilterHomewall && sizeId != null && isKilterHomewallWideSizeId(sizeId);

  useEffect(() => {
    if (selection.type !== 'on') return;
    const shouldClearTallClimbs = selection.options.onlyTallClimbs && !showTallClimbsFilter;
    const shouldClearWideClimbs = selection.options.onlyWideClimbs && !showWideClimbsFilter;
    if (!shouldClearTallClimbs && !shouldClearWideClimbs) return;
    onChange({
      type: 'on',
      options: {
        ...selection.options,
        ...(shouldClearTallClimbs ? { onlyTallClimbs: false } : {}),
        ...(shouldClearWideClimbs ? { onlyWideClimbs: false } : {}),
      },
    });
  }, [selection, showTallClimbsFilter, showWideClimbsFilter, onChange]);

  const railGrades = useMemo(() => toRailGrades(boardName), [boardName]);
  const generatorGrades = useMemo(() => (boardName ? getGradesForBoard(boardName) : []), [boardName]);
  const activeType = selection.type === 'on' ? selection.options.type : 'off';

  const minAscentsOptions = useMemo(() => {
    const baseOptions = getMinAscentsFilterOptions();
    if (selection.type !== 'on' || baseOptions.includes(selection.options.minAscents)) return baseOptions;
    return [...baseOptions, selection.options.minAscents].sort((first, second) => first - second);
  }, [selection]);

  const handleSelectType = useCallback(
    (value: ChipValue) => {
      hapticSelection();
      if (value === 'off') {
        onChange({ type: 'off' });
        return;
      }
      // Enabling the generator (off → a workout type) reveals the configurator —
      // the mobile analogue of web's `Workout Generator Opened`. Match web's exact
      // payload (playlist-generator-drawer.tsx): `{ targetType, boardName, angle }`.
      // The pre-session flow always feeds the session queue, so targetType is
      // 'session'; PostHog groups by exact prop name, so the keys must line up.
      if (selection.type === 'off') {
        track(SHARED_EVENTS.WorkoutGeneratorOpened, { targetType: 'session', boardName, angle });
      }
      const currentTarget = selection.type === 'on' ? selection.options.targetGrade : getDefaultTargetGrade(boardName);
      onChange({ type: 'on', options: buildDefaultOptions(value, currentTarget) });
    },
    [angle, boardName, onChange, selection],
  );

  const shelfItems = useMemo<WorkoutTypeShelfItem[]>(() => {
    const groupLabel = t('mobile.session.preGeneratorLabel');
    const targetGrade = selection.type === 'on' ? selection.options.targetGrade : getDefaultTargetGrade(boardName);
    const commonPatch: CommonGeneratorPatch =
      selection.type === 'on'
        ? {
            warmUp: selection.options.warmUp,
            targetGrade,
            climbBias: selection.options.climbBias,
            minAscents: selection.options.minAscents,
            minRating: selection.options.minRating,
            onlyTallClimbs: selection.options.onlyTallClimbs,
            onlyWideClimbs: selection.options.onlyWideClimbs,
          }
        : { targetGrade };

    return CHIP_VALUES.map((value) => {
      const label = chipLabel(value, t);
      if (value === 'off') {
        return {
          key: value,
          label,
          selected: activeType === value,
          bars: null,
          emptyIcon: 'hand.raised',
          onPress: () => handleSelectType(value),
          accessibilityLabel: t('mobile.session.preGeneratorOptionAccessibilityLabel', {
            group: groupLabel,
            value: label,
          }),
        };
      }

      const options: GeneratorOptions =
        selection.type === 'on' && selection.options.type === value
          ? selection.options
          : ({ ...buildDefaultOptions(value, targetGrade), ...commonPatch } as GeneratorOptions);
      const slots = generateWorkoutPlan(options, generatorGrades);
      const bars =
        value === 'pyramid'
          ? buildWorkoutProgressionBars(slots, formatGradeByDifficultyId, generatorGrades)
          : buildWorkoutGradeBars(slots, formatGradeByDifficultyId);
      const chartSummary =
        value === 'pyramid'
          ? slots
              .map((slot, slotIndex) =>
                t('mobile.session.preGeneratorChartProgressPoint', {
                  index: slotIndex + 1,
                  grade: formatGradeByDifficultyId(slot.grade) ?? String(slot.grade),
                }),
              )
              .join(' · ')
          : bars
              ?.map((bar) =>
                t('mobile.session.preGeneratorChartPoint', {
                  count: getChartClimbCount(bar),
                  grade: bar.label,
                }),
              )
              .join(' · ');
      const accessibleValue = chartSummary
        ? t('mobile.session.preGeneratorOptionChartValue', { value: label, summary: chartSummary })
        : label;

      return {
        key: value,
        label,
        selected: activeType === value,
        bars,
        onPress: () => handleSelectType(value),
        accessibilityLabel: t('mobile.session.preGeneratorOptionAccessibilityLabel', {
          group: groupLabel,
          value: accessibleValue,
        }),
      };
    });
  }, [activeType, boardName, formatGradeByDifficultyId, generatorGrades, handleSelectType, selection, t]);

  const updateCommonOptions = (patch: CommonGeneratorPatch) => {
    if (selection.type !== 'on') return;
    onChange({ type: 'on', options: { ...selection.options, ...patch } });
  };

  // Recollapse the Tuning section on generator-type change so a freshly picked
  // workout shows its defaults summarised rather than a stale expanded state.
  const tuningResetKey = activeType === 'off' ? 0 : CHIP_VALUES.indexOf(activeType);

  // Tuning summary, built like ClimbFilterSheet's refineSummary: min ascents ·
  // stars · climb bias. Stars render as filled glyphs (a symbol, not
  // translatable copy); "Any" rating shows nothing so the line stays short.
  const tuningSummary = useMemo(() => {
    if (selection.type !== 'on') return null;
    const { options } = selection;
    const parts: string[] = [];
    parts.push(
      t('mobile.session.preGeneratorMinAscentsOption', { value: formatMinAscentsFilterCount(options.minAscents) }),
    );
    const ratingValue = getMinRatingPickerValue(options.minRating);
    if (ratingValue != null && ratingValue > 0) parts.push('★'.repeat(ratingValue));
    parts.push(climbBiasLabel(options.climbBias, t));
    return parts.join(' · ');
  }, [selection, t]);

  // A stepper row with an already-translated label; resolves the decrease /
  // increase accessibility labels off the same label. Callers pass the resolved
  // string (via a literal `t('mobile.session.preGenerator…')`) so the i18n key
  // stays statically analysable.
  const stepperRow = (
    label: string,
    fieldKey: string,
    value: number,
    min: number,
    max: number,
    onValue: (next: number) => void,
  ): StepperRow => ({
    key: fieldKey,
    node: (
      <Stepper
        label={label}
        value={value}
        min={min}
        max={max}
        onChange={onValue}
        decreaseLabel={t('mobile.session.preGeneratorDecreaseOption', { label })}
        increaseLabel={t('mobile.session.preGeneratorIncreaseOption', { label })}
      />
    ),
  });

  // Primary count stepper(s) shown directly under the workout type. Volume:
  // main-set climbs; pyramid/ladder: number of steps; grade focus: climbs.
  const primarySteppers = (options: GeneratorOptions): StepperRow[] => {
    switch (options.type) {
      case 'volume':
        return [
          stepperRow(
            t('mobile.session.preGeneratorMainSetClimbs'),
            'mainSetClimbs',
            options.mainSetClimbs,
            1,
            50,
            (mainSetClimbs) => onChange({ type: 'on', options: { ...options, mainSetClimbs } }),
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
            (numberOfSteps) => onChange({ type: 'on', options: { ...options, numberOfSteps } }),
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
            (numberOfClimbs) => onChange({ type: 'on', options: { ...options, numberOfClimbs } }),
          ),
        ];
    }
  };

  // Each shape's secondary knob — Volume's variability ("grade spread") and
  // pyramid/ladder's climbs-per-step. Shown in the primary group next to the main
  // count (promoted out of Tuning for discoverability); Grade Focus has none.
  const secondarySteppers = (options: GeneratorOptions): StepperRow[] => {
    switch (options.type) {
      case 'volume':
        return [
          stepperRow(
            t('mobile.session.preGeneratorMainSetVariability'),
            'mainSetVariability',
            options.mainSetVariability,
            0,
            5,
            (mainSetVariability) => onChange({ type: 'on', options: { ...options, mainSetVariability } }),
          ),
        ];
      case 'pyramid':
      case 'ladder':
        return [
          stepperRow(
            t('mobile.session.preGeneratorClimbsPerStep'),
            'climbsPerStep',
            options.climbsPerStep,
            1,
            5,
            (climbsPerStep) => onChange({ type: 'on', options: { ...options, climbsPerStep } }),
          ),
        ];
      case 'gradeFocus':
        return [];
    }
  };

  const warmUpOptions = useMemo(
    () => WARM_UP_OPTIONS.map((warmUp) => ({ key: warmUp, label: warmUpLabel(warmUp, t) })),
    [t],
  );
  const climbBiasOptions = useMemo(
    () => CLIMB_BIAS_OPTIONS.map((climbBias) => ({ key: climbBias, label: climbBiasLabel(climbBias, t) })),
    [t],
  );

  const renderTuning = (options: GeneratorOptions): ReactNode => {
    const minRatingPickerValue = getMinRatingPickerValue(options.minRating);
    return (
      <View style={styles.tuningBody}>
        <View>
          <Text variant="footnote" style={styles.subsectionLabel}>
            {t('mobile.session.preGeneratorMinAscents')}
          </Text>
          <View style={styles.chipRow}>
            {minAscentsOptions.map((minAscents) => {
              const label = t('mobile.session.preGeneratorMinAscentsOption', {
                value: formatMinAscentsFilterCount(minAscents),
              });
              return (
                <Chip
                  key={minAscents}
                  label={label}
                  selected={options.minAscents === minAscents}
                  onPress={() => updateCommonOptions({ minAscents })}
                  accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                    group: t('mobile.session.preGeneratorMinAscents'),
                    value: label,
                  })}
                />
              );
            })}
          </View>
        </View>

        <View>
          <Text variant="footnote" style={styles.subsectionLabel}>
            {t('mobile.session.preGeneratorMinRating')}
          </Text>
          <View style={styles.ratingRow}>
            <Chip
              label={t('mobile.session.preGeneratorAny')}
              selected={minRatingPickerValue == null}
              onPress={() => updateCommonOptions({ minRating: 0 })}
              accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                group: t('mobile.session.preGeneratorMinRating'),
                value: t('mobile.session.preGeneratorAny'),
              })}
            />
            <StarRating
              value={minRatingPickerValue ?? undefined}
              onChange={(rating) => updateCommonOptions({ minRating: rating ?? 0 })}
              accessibilityHint={t('mobile.session.preGeneratorMinRatingStarHint')}
              getAccessibilityLabel={(rating, selected) =>
                t(
                  selected
                    ? 'mobile.session.preGeneratorMinRatingStarSelectedAccessibilityLabel'
                    : 'mobile.session.preGeneratorMinRatingStarAccessibilityLabel',
                  { count: rating },
                )
              }
            />
          </View>
        </View>

        <View>
          <Text variant="footnote" style={styles.subsectionLabel}>
            {t('mobile.session.preGeneratorClimbBias')}
          </Text>
          <SegmentedControl
            options={climbBiasOptions}
            selectedKey={options.climbBias}
            onSelect={(climbBias) => updateCommonOptions({ climbBias })}
            textVariant="footnote"
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.session.preGeneratorClimbBias')}
          />
        </View>

        {showTallClimbsFilter || showWideClimbsFilter ? (
          <View style={[styles.groupedCard, isMaterial && { backgroundColor: m3.surfaceVariant }]}>
            {showTallClimbsFilter ? (
              <SwitchRow
                label={t('mobile.session.preGeneratorTallClimbsLabel')}
                description={t('mobile.session.preGeneratorTallClimbsDescription')}
                value={options.onlyTallClimbs}
                onValueChange={(onlyTallClimbs) => updateCommonOptions({ onlyTallClimbs })}
              />
            ) : null}
            {showTallClimbsFilter && showWideClimbsFilter ? (
              <View
                style={[
                  styles.groupDivider,
                  { backgroundColor: isMaterial ? m3.outlineVariant : systemColors.separator },
                ]}
              />
            ) : null}
            {showWideClimbsFilter ? (
              <SwitchRow
                label={t('mobile.session.preGeneratorWideClimbsLabel')}
                description={t('mobile.session.preGeneratorWideClimbsDescription')}
                value={options.onlyWideClimbs}
                onValueChange={(onlyWideClimbs) => updateCommonOptions({ onlyWideClimbs })}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View>
      <SectionHeader title={t('mobile.session.preGeneratorLabel')} />
      <WorkoutTypeShelf items={shelfItems} />

      {selection.type === 'on' ? (
        <>
          {boardName != null ? (
            <>
              <SectionHeader title={t('mobile.session.preGeneratorTargetGrade')} />
              <GradeSingleSelectRail
                grades={railGrades}
                selectedDifficultyId={selection.options.targetGrade}
                onSelect={(difficultyId) =>
                  updateCommonOptions({ targetGrade: difficultyId ?? selection.options.targetGrade })
                }
                allowClear={false}
              />
            </>
          ) : null}

          <SectionHeader title={t('mobile.session.preGeneratorWarmUp')} />
          <View style={[styles.inset, styles.warmUpInset]}>
            <SegmentedControl
              options={warmUpOptions}
              selectedKey={selection.options.warmUp}
              onSelect={(warmUp) => updateCommonOptions({ warmUp })}
              textVariant="footnote"
              trackColor={systemColors.fill}
              accessibilityLabel={t('mobile.session.preGeneratorWarmUp')}
            />
          </View>

          <View style={[styles.inset, styles.steppersInset]}>
            <GroupedSteppers rows={[...primarySteppers(selection.options), ...secondarySteppers(selection.options)]} />
          </View>

          <View style={[styles.inset, styles.tuningInset]}>
            <CollapsibleSection
              title={t('mobile.session.preGeneratorTuning')}
              summary={tuningSummary}
              resetKey={tuningResetKey}
            >
              {renderTuning(selection.options)}
            </CollapsibleSection>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // SectionHeader brings its own 16px inset; matching horizontal padding lines
  // the grouped content up with the screen's other cards and section headers.
  inset: {
    paddingHorizontal: spacing[4],
  },
  // The grade rail self-insets, so the stepper card sits a little below it.
  steppersInset: {
    marginTop: spacing[2],
  },
  warmUpInset: {
    marginBottom: spacing[2],
  },
  tuningInset: {
    marginTop: spacing[3],
  },
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
    backgroundColor: `${iosSystemColors.systemGray}14`,
    overflow: 'hidden',
  },
  groupDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4],
  },
  tuningBody: {
    gap: spacing[4],
  },
  subsectionLabel: {
    opacity: 0.55,
    marginBottom: spacing[2],
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
});
