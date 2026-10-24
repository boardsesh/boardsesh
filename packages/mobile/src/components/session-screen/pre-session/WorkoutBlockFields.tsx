// One block's own settings: the type chips, then a target grade and the count
// steppers for a workout, or the warm-up length and what it ramps to for a
// warm-up, then the block's climb filters, folded. The Record tab shows it under a block card's header; the in-session
// "Add a block" sheet can show it alone with workout types only. It sits in a
// container that already insets it 16pt (a Card does), and the grade rail
// bleeds back out to that container's edges.

import { useCallback, useMemo } from 'react';
import { StyleSheet, View, type Insets } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName, Grade } from '@boardsesh/shared-schema';
import type { GeneratorOptions, WarmUpStageType, WorkoutBlockSpec } from '@boardsesh/playlist-generator';
import { SegmentedControl } from '../../SegmentedControl';
import { Text } from '../../Text';
import { GradeSingleSelectRail } from '../../grade';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { ShowcaseAnchorView } from '../../../lib/showcase-anchor';
import { workoutStageName } from '../../../lib/workout-run-readout';
import { Chip, GroupedSteppers, generatorControlStyles, workoutStepperRows } from './generator-controls';
import { WorkoutBlockFilters } from './WorkoutBlockFilters';
import {
  WORKOUT_BLOCK_TYPES,
  blockType,
  type SizeFilterAvailability,
  type WorkoutBlockType,
  type WorkoutFilters,
} from './workout-blocks';

// Chips draw ~34pt tall; this brings each touch target to 44pt.
const CHIP_HIT_SLOP: Insets = { top: 6, bottom: 6 };
const WARM_UP_LENGTHS: readonly WarmUpStageType[] = ['standard', 'extended'];

type Translate = (key: string) => string;

export function warmUpLengthLabel(warmUpType: WarmUpStageType, t: Translate): string {
  switch (warmUpType) {
    case 'standard':
      return t('mobile.session.preGeneratorWarmUpStandard');
    case 'extended':
      return t('mobile.session.preGeneratorWarmUpExtended');
  }
}

type WorkoutBlockFieldsProps = {
  block: WorkoutBlockSpec;
  boardName: BoardName | null;
  railGrades: readonly Grade[];
  /** Names the chip group for screen readers ("Block 2, Pyramid"). */
  groupLabel: string;
  /** The type chips, in order. Every type by default, warm-up first. */
  blockTypes?: readonly WorkoutBlockType[];
  /** For a warm-up: the grade it ramps to, null when no workout block follows it. */
  warmUpTargetGrade?: number | null;
  /** For a warm-up: the 1-based number of the block it ramps to. */
  warmUpTargetBlockNumber?: number | null;
  /** The block's own climb filters. */
  filters: WorkoutFilters;
  /** Which size filters the board offers. */
  sizeFilters: SizeFilterAvailability;
  onTypeChange: (type: WorkoutBlockType) => void;
  onBlockChange: (block: WorkoutBlockSpec) => void;
  onFiltersChange: (patch: Partial<WorkoutFilters>) => void;
};

export function WorkoutBlockFields({
  block,
  boardName,
  railGrades,
  groupLabel,
  blockTypes = WORKOUT_BLOCK_TYPES,
  warmUpTargetGrade = null,
  warmUpTargetBlockNumber = null,
  filters,
  sizeFilters,
  onTypeChange,
  onBlockChange,
  onFiltersChange,
}: WorkoutBlockFieldsProps) {
  const { t } = useTranslation('session');
  const selectedType = blockType(block);

  return (
    <View style={styles.fields}>
      <View style={generatorControlStyles.chipRow}>
        {blockTypes.map((type) => {
          const label = workoutStageName(type, t);
          const selected = selectedType === type;
          return (
            // Only the selected chip reports (screenshot mode); a pass-through elsewhere.
            <ShowcaseAnchorView key={type} name="workout-type" enabled={selected}>
              <Chip
                label={label}
                selected={selected}
                onPress={() => onTypeChange(type)}
                hitSlop={CHIP_HIT_SLOP}
                accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                  group: groupLabel,
                  value: label,
                })}
              />
            </ShowcaseAnchorView>
          );
        })}
      </View>

      {block.kind === 'warmUp' ? (
        <WarmUpFields
          warmUpType={block.warmUpType}
          boardName={boardName}
          targetGrade={warmUpTargetGrade}
          targetBlockNumber={warmUpTargetBlockNumber}
          onBlockChange={onBlockChange}
        />
      ) : (
        <WorkoutFields
          options={block.options}
          boardName={boardName}
          railGrades={railGrades}
          onBlockChange={onBlockChange}
        />
      )}

      <WorkoutBlockFilters
        filters={filters}
        boardName={boardName}
        sizeFilters={sizeFilters}
        onFiltersChange={onFiltersChange}
      />
    </View>
  );
}

type WorkoutFieldsProps = {
  options: GeneratorOptions;
  boardName: BoardName | null;
  railGrades: readonly Grade[];
  onBlockChange: (block: WorkoutBlockSpec) => void;
};

function WorkoutFields({ options, boardName, railGrades, onBlockChange }: WorkoutFieldsProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const handleOptionsChange = useCallback(
    (nextOptions: GeneratorOptions) => onBlockChange({ kind: 'workout', options: nextOptions }),
    [onBlockChange],
  );
  const handleGradeSelect = useCallback(
    (difficultyId: number | undefined) =>
      handleOptionsChange({ ...options, targetGrade: difficultyId ?? options.targetGrade }),
    [handleOptionsChange, options],
  );
  const stepperRows = useMemo(
    () => workoutStepperRows(options, t, handleOptionsChange),
    [options, t, handleOptionsChange],
  );

  return (
    <>
      {boardName != null ? (
        <View>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.subsectionLabel}>
            {t('mobile.session.preGeneratorTargetGrade')}
          </Text>
          <View style={styles.railBleed}>
            <GradeSingleSelectRail
              grades={railGrades}
              selectedDifficultyId={options.targetGrade}
              boardName={boardName}
              onSelect={handleGradeSelect}
              allowClear={false}
            />
          </View>
        </View>
      ) : null}

      <GroupedSteppers rows={stepperRows} />
    </>
  );
}

type WarmUpFieldsProps = {
  warmUpType: WarmUpStageType;
  boardName: BoardName | null;
  targetGrade: number | null;
  targetBlockNumber: number | null;
  onBlockChange: (block: WorkoutBlockSpec) => void;
};

function WarmUpFields({ warmUpType, boardName, targetGrade, targetBlockNumber, onBlockChange }: WarmUpFieldsProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const lengthOptions = useMemo(
    () => WARM_UP_LENGTHS.map((length) => ({ key: length, label: warmUpLengthLabel(length, t) })),
    [t],
  );
  const handleLengthSelect = useCallback(
    (nextWarmUpType: WarmUpStageType) => onBlockChange({ kind: 'warmUp', warmUpType: nextWarmUpType }),
    [onBlockChange],
  );
  const targetNote =
    targetGrade != null && targetBlockNumber != null
      ? t('mobile.session.preGeneratorWarmUpTarget', {
          grade: formatGradeByDifficultyId(targetGrade, boardName) ?? String(targetGrade),
          position: targetBlockNumber,
        })
      : t('mobile.session.preGeneratorWarmUpNoTarget');

  return (
    <>
      <SegmentedControl
        options={lengthOptions}
        selectedKey={warmUpType}
        onSelect={handleLengthSelect}
        accessibilityLabel={t('mobile.session.preGeneratorWarmUp')}
      />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {targetNote}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  fields: {
    gap: spacing[3],
  },
  subsectionLabel: {
    marginBottom: spacing[2],
  },
  // The rail insets its own chips 16pt; cancelling the container's inset lets
  // it scroll edge to edge while its first chip lines up with the content.
  railBleed: {
    marginHorizontal: -spacing[4],
  },
});
