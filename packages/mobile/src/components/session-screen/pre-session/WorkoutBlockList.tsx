import { memo, useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import type { BoardName, Grade } from '@boardsesh/shared-schema';
import type { GeneratorOptions, WorkoutType } from '@boardsesh/playlist-generator';
import { Icon } from '../../Icon';
import type { IconName } from '../../icon-map';
import { PressableSurface } from '../../PressableSurface';
import { SectionHeader } from '../../SectionHeader';
import { Text } from '../../Text';
import { GradeSingleSelectRail } from '../../grade';
import { hapticSelection } from '../../../lib/haptics';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { Chip, GroupedSteppers, generatorControlStyles, workoutStepperRows } from './generator-controls';
import { workoutStageName } from '../../../lib/workout-run-readout';
import {
  MAX_WORKOUT_BLOCKS,
  addBlock,
  canAddBlock,
  changeBlockType,
  moveBlock,
  removeBlock,
  updateBlockOptions,
  type ActiveGeneratorSelection,
  type ExtraWorkoutBlock,
  type GeneratorSelection,
} from './workout-blocks';

const BLOCK_TYPES: readonly WorkoutType[] = ['volume', 'pyramid', 'ladder', 'gradeFocus'];

// Block ids key the editors on this screen. Uuids, like the stage ids: a module
// counter restarts on a Fast Refresh while the selection in PreSessionView state
// survives it, and could hand a new block an id that is already in use.
const makeBlockId = () => randomUUID();

type WorkoutBlockListProps = {
  boardName: BoardName | null;
  railGrades: readonly Grade[];
  selection: ActiveGeneratorSelection;
  onChange: (selection: GeneratorSelection) => void;
};

/**
 * The workout blocks after the first card, then "Add a block". Each block runs
 * after the one above it; the first card's warm-up opens the session and its
 * Tuning filters apply to every block, so a block only picks its type, target
 * grade and counts.
 */
export function WorkoutBlockList({ boardName, railGrades, selection, onChange }: WorkoutBlockListProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  // The editors' callbacks read the latest selection through a ref, so they keep
  // one identity across edits and the memoised editors only re-render when their
  // own block changes.
  const selectionRef = useRef<GeneratorSelection>(selection);
  selectionRef.current = selection;

  const handleTypeChange = useCallback(
    (blockId: string, type: WorkoutType) => onChange(changeBlockType(selectionRef.current, blockId, type)),
    [onChange],
  );
  const handleOptionsChange = useCallback(
    (blockId: string, options: GeneratorOptions) =>
      onChange(updateBlockOptions(selectionRef.current, blockId, options)),
    [onChange],
  );
  const handleRemove = useCallback(
    (blockId: string) => onChange(removeBlock(selectionRef.current, blockId)),
    [onChange],
  );
  const handleMove = useCallback(
    (blockId: string, direction: 'up' | 'down') => onChange(moveBlock(selectionRef.current, blockId, direction)),
    [onChange],
  );
  const handleAdd = useCallback(() => {
    hapticSelection();
    onChange(addBlock(selectionRef.current, makeBlockId));
  }, [onChange]);

  const lastExtraPosition = selection.extraBlocks.length - 1;

  return (
    <View>
      {selection.extraBlocks.map((block, extraPosition) => (
        <WorkoutBlockEditor
          key={block.id}
          block={block}
          // The first card is block 1.
          position={extraPosition + 2}
          canMoveUp={extraPosition > 0}
          canMoveDown={extraPosition < lastExtraPosition}
          boardName={boardName}
          railGrades={railGrades}
          onTypeChange={handleTypeChange}
          onOptionsChange={handleOptionsChange}
          onRemove={handleRemove}
          onMove={handleMove}
        />
      ))}

      <View style={styles.addRow}>
        {canAddBlock(selection) ? (
          <PressableSurface
            onPress={handleAdd}
            feedback="opacity"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.session.preGeneratorAddBlock')}
            accessibilityHint={t('mobile.session.preGeneratorAddBlockHint')}
            style={styles.addButton}
          >
            <Icon name="add" size={18} color={brandColors.primary} />
            <Text variant="subheadline" color={brandColors.primary} style={styles.addText}>
              {t('mobile.session.preGeneratorAddBlock')}
            </Text>
          </PressableSurface>
        ) : (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.session.preGeneratorBlockLimit', { max: MAX_WORKOUT_BLOCKS })}
          </Text>
        )}
      </View>
    </View>
  );
}

type WorkoutBlockEditorProps = {
  block: ExtraWorkoutBlock;
  /** 1-based, counting the first card as block 1. */
  position: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  boardName: BoardName | null;
  railGrades: readonly Grade[];
  onTypeChange: (blockId: string, type: WorkoutType) => void;
  onOptionsChange: (blockId: string, options: GeneratorOptions) => void;
  onRemove: (blockId: string) => void;
  onMove: (blockId: string, direction: 'up' | 'down') => void;
};

/** One extra block: its title with move and remove, the type chips, a target grade and the count steppers. */
const WorkoutBlockEditor = memo(function WorkoutBlockEditor({
  block,
  position,
  canMoveUp,
  canMoveDown,
  boardName,
  railGrades,
  onTypeChange,
  onOptionsChange,
  onRemove,
  onMove,
}: WorkoutBlockEditorProps) {
  const { t } = useTranslation('session');
  const { id: blockId, options } = block;
  const title = t('mobile.session.preGeneratorBlockTitle', { position });
  // Stable per block, so the rail and the steppers don't get a new handler on every render.
  const handleOptionsChange = useCallback(
    (nextOptions: GeneratorOptions) => onOptionsChange(blockId, nextOptions),
    [onOptionsChange, blockId],
  );
  const handleTypeChange = useCallback((type: WorkoutType) => onTypeChange(blockId, type), [onTypeChange, blockId]);
  const handleMoveUp = useCallback(() => onMove(blockId, 'up'), [onMove, blockId]);
  const handleMoveDown = useCallback(() => onMove(blockId, 'down'), [onMove, blockId]);
  const handleRemove = useCallback(() => onRemove(blockId), [onRemove, blockId]);
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
    <View style={styles.block} testID={`workout-block-${position}`}>
      <View style={styles.blockHeader}>
        <View style={styles.blockTitle}>
          <SectionHeader title={title} />
        </View>
        <View style={styles.blockActions}>
          <BlockActionButton
            icon="chevron.up"
            disabled={!canMoveUp}
            onPress={handleMoveUp}
            accessibilityLabel={t('mobile.session.preGeneratorMoveBlockUpAccessibilityLabel', { position })}
          />
          <BlockActionButton
            icon="chevron.down"
            disabled={!canMoveDown}
            onPress={handleMoveDown}
            accessibilityLabel={t('mobile.session.preGeneratorMoveBlockDownAccessibilityLabel', { position })}
          />
          <BlockActionButton
            icon="delete"
            onPress={handleRemove}
            accessibilityLabel={t('mobile.session.preGeneratorRemoveBlockAccessibilityLabel', { position })}
          />
        </View>
      </View>

      <View style={[styles.inset, generatorControlStyles.chipRow]}>
        {BLOCK_TYPES.map((type) => {
          const label = workoutStageName(type, t);
          return (
            <Chip
              key={type}
              label={label}
              selected={options.type === type}
              onPress={() => handleTypeChange(type)}
              accessibilityLabel={t('mobile.session.preGeneratorOptionAccessibilityLabel', {
                group: title,
                value: label,
              })}
            />
          );
        })}
      </View>

      {boardName != null ? (
        <View style={styles.gradeRail}>
          <Text variant="footnote" style={[styles.inset, styles.subsectionLabel]}>
            {t('mobile.session.preGeneratorTargetGrade')}
          </Text>
          <GradeSingleSelectRail
            grades={railGrades}
            selectedDifficultyId={options.targetGrade}
            boardName={boardName}
            onSelect={handleGradeSelect}
            allowClear={false}
          />
        </View>
      ) : null}

      <View style={[styles.inset, styles.steppers]}>
        <GroupedSteppers rows={stepperRows} />
      </View>
    </View>
  );
});

type BlockActionButtonProps = {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
};

function BlockActionButton({ icon, onPress, accessibilityLabel, disabled = false }: BlockActionButtonProps) {
  const { brandColors, opacity } = useTheme();
  return (
    <PressableSurface
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      disabled={disabled}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={[styles.actionButton, disabled ? { opacity: opacity.disabled } : null]}
    >
      <Icon name={icon} size={18} color={brandColors.primary} />
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  inset: {
    paddingHorizontal: spacing[4],
  },
  block: {
    marginTop: spacing[4],
  },
  blockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  blockTitle: {
    flex: 1,
  },
  blockActions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingEnd: spacing[2],
  },
  // 44pt square: the minimum touch target for an icon-only button.
  actionButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradeRail: {
    marginTop: spacing[3],
  },
  subsectionLabel: {
    opacity: 0.55,
    marginBottom: spacing[2],
  },
  steppers: {
    marginTop: spacing[2],
  },
  addRow: {
    paddingHorizontal: spacing[4],
    marginTop: spacing[4],
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing[2],
    minHeight: 44,
  },
  addText: {
    fontWeight: '600',
  },
});
