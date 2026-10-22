import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { getGradesForBoard } from '@boardsesh/board-config';
import { getTallWideScope } from '@boardsesh/board-constants';
import {
  formatMinAscentsFilterCount,
  getMinAscentsFilterOptions,
  getMinRatingPickerValue,
} from '@boardsesh/climb-filters';
import {
  CLIMB_BIAS_OPTIONS,
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
import { Text } from '../../Text';
import { GradeSingleSelectRail } from '../../grade';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useTheme } from '../../../providers/theme-provider';
import { selectByVariant } from '../../../theme/variants';
import { hapticSelection } from '../../../lib/haptics';
import { spacing } from '../../../theme/tokens';
import type { ColoredBar } from '../../you/profile-chart-colors';
import { WorkoutTypeShelf, type WorkoutTypeShelfItem } from './WorkoutTypeShelf';
import { buildWorkoutGradeBars, buildWorkoutProgressionBars } from './workout-type-shelf-data';
import {
  Chip,
  GroupedSteppers,
  generatorControlStyles,
  getDefaultTargetGrade,
  toRailGrades,
  workoutStepperRows,
} from './generator-controls';
import { workoutStageName } from '../../../lib/workout-run-readout';
import { buildDefaultOptions, singleBlockSelection, type GeneratorSelection } from './workout-blocks';
import { WorkoutBlockList } from './WorkoutBlockList';

export type { GeneratorSelection } from './workout-blocks';

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
  return value === 'off' ? t('mobile.session.preGeneratorOff') : workoutStageName(value, t);
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

function getChartClimbCount(bar: ColoredBar): number {
  return bar.segments.reduce((total, segment) => total + segment.value, 0);
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
 *
 * This card is the first workout block. Below it `WorkoutBlockList` adds more
 * blocks that run after it; the warm-up and the Tuning filters here apply to
 * the whole session.
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
  const { formatGradeByDifficultyId: formatAnyBoardGradeByDifficultyId } = useGradeFormat();
  const formatGradeByDifficultyId = useCallback(
    (difficultyId: number | null | undefined) => formatAnyBoardGradeByDifficultyId(difficultyId, boardName),
    [formatAnyBoardGradeByDifficultyId, boardName],
  );
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });

  const tallWideScope =
    boardName != null && layoutId != null && sizeId != null ? getTallWideScope(boardName, layoutId, sizeId) : null;
  const showTallClimbsFilter = tallWideScope?.hasShorter ?? false;
  const showWideClimbsFilter = tallWideScope?.hasNarrower ?? false;

  useEffect(() => {
    if (selection.type !== 'on') return;
    const shouldClearTallClimbs = selection.options.onlyTallClimbs && !showTallClimbsFilter;
    const shouldClearWideClimbs = selection.options.onlyWideClimbs && !showWideClimbsFilter;
    if (!shouldClearTallClimbs && !shouldClearWideClimbs) return;
    onChange({
      ...selection,
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
      if (selection.type === 'off') {
        onChange(singleBlockSelection(buildDefaultOptions(value, getDefaultTargetGrade(boardName))));
        return;
      }
      // Switching the first block's type keeps the blocks after it.
      onChange({ ...selection, options: buildDefaultOptions(value, selection.options.targetGrade) });
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
    onChange({ ...selection, options: { ...selection.options, ...patch } });
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

  const updateFirstBlockOptions = (options: GeneratorOptions) => {
    if (selection.type !== 'on') return;
    onChange({ ...selection, options });
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
          <View style={generatorControlStyles.chipRow}>
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
          <View
            style={[
              generatorControlStyles.groupedCard,
              { backgroundColor: isMaterial ? m3.surfaceVariant : systemColors.fill },
            ]}
          >
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
                  generatorControlStyles.groupDivider,
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
                boardName={boardName}
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
            <GroupedSteppers rows={workoutStepperRows(selection.options, t, updateFirstBlockOptions)} />
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

          <WorkoutBlockList boardName={boardName} railGrades={railGrades} selection={selection} onChange={onChange} />
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
