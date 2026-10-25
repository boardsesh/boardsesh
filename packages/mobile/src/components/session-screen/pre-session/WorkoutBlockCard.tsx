// One workout block on the Record tab: a header with its number, its type, a
// ⋯ menu to move or remove it and a disclosure chevron, then its fields and its
// own climb filters while open. Warm-ups and workouts share this card, so every block reads the same.

import { memo, useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName, Grade } from '@boardsesh/shared-schema';
import type { WorkoutBlockSpec } from '@boardsesh/playlist-generator';
import { AppMenu, type AppMenuAction } from '../../AppMenu';
import { Card } from '../../Card';
import { PressableSurface } from '../../PressableSurface';
import { SectionDisclosureChevron } from '../../SectionDisclosureChevron';
import { Text } from '../../Text';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { hapticSelection } from '../../../lib/haptics';
import { workoutStageName } from '../../../lib/workout-run-readout';
import { formatRestLength } from '../../queue-control/rest-length.logic';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { WorkoutBlockFields, warmUpLengthLabel } from './WorkoutBlockFields';
import {
  DEFAULT_WORKOUT_FILTERS,
  blockType,
  sameFilters,
  type SizeFilterAvailability,
  type WorkoutBlock,
  type WorkoutBlockType,
  type WorkoutFilters,
} from './workout-blocks';

type Translate = (key: string, options?: Record<string, string | number>) => string;
type MoveDirection = 'up' | 'down';
type BlockAction = 'moveUp' | 'moveDown' | 'remove';

/**
 * Which way a warm-up's grades run: `up` to the workout block after it, or
 * `down` from the last workout block before it (a cool-down). `grade` is that
 * block's target grade.
 */
export type WarmUpRamp = { direction: 'up' | 'down'; grade: number };

/**
 * The one-line summary under a closed card's type: `V6 · 20 climbs · spread 0`
 * for a workout, `V6 · 4 reps × 4 sets · 3:00 between sets` for a 4x4 (reps first, sets second),
 * `Standard · ramps to V6` for a warm-up, `Standard · eases off from V6` for one
 * after the last workout block. `filtered` adds a `· filtered` marker, for a
 * block whose climb filters are not the defaults.
 */
export function blockSummary(
  block: WorkoutBlockSpec,
  formatGrade: (difficultyId: number) => string,
  warmUpRamp: WarmUpRamp | null,
  t: Translate,
  filtered = false,
): string {
  const parts = blockSettingsSummary(block, formatGrade, warmUpRamp, t);
  if (filtered) parts.push(t('mobile.session.preGeneratorBlockSummaryFiltered'));
  return parts.join(' · ');
}

function warmUpRampSummary(
  warmUpRamp: WarmUpRamp | null,
  formatGrade: (difficultyId: number) => string,
  t: Translate,
): string {
  if (!warmUpRamp) return t('mobile.session.preGeneratorWarmUpSummaryNoTarget');
  const grade = formatGrade(warmUpRamp.grade);
  return warmUpRamp.direction === 'up'
    ? t('mobile.session.preGeneratorWarmUpSummaryRamps', { grade })
    : t('mobile.session.preGeneratorCoolDownSummaryEasesOff', { grade });
}

function blockSettingsSummary(
  block: WorkoutBlockSpec,
  formatGrade: (difficultyId: number) => string,
  warmUpRamp: WarmUpRamp | null,
  t: Translate,
): string[] {
  if (block.kind === 'warmUp') {
    return [warmUpLengthLabel(block.warmUpType, t), warmUpRampSummary(warmUpRamp, formatGrade, t)];
  }
  const { options } = block;
  const parts = [formatGrade(options.targetGrade)];
  switch (options.type) {
    case 'volume':
      parts.push(
        t('mobile.session.preGeneratorBlockSummaryClimbs', { count: options.mainSetClimbs }),
        t('mobile.session.preGeneratorBlockSummarySpread', { value: options.mainSetVariability }),
      );
      break;
    case 'pyramid':
    case 'ladder':
      parts.push(
        t('mobile.session.preGeneratorBlockSummarySteps', { count: options.numberOfSteps }),
        t('mobile.session.preGeneratorBlockSummaryPerStep', { count: options.climbsPerStep }),
      );
      if (options.type === 'ladder' && options.descending === true) {
        parts.push(t('mobile.session.preGeneratorBlockSummaryHardestFirst'));
      }
      break;
    case 'gradeFocus':
      parts.push(t('mobile.session.preGeneratorBlockSummaryClimbs', { count: options.numberOfClimbs }));
      break;
    case 'onTheMinute':
      parts.push(
        t('mobile.session.preGeneratorBlockSummaryClimbs', { count: options.numberOfClimbs }),
        t('mobile.session.preGeneratorBlockSummaryEvery', { value: formatRestLength(options.intervalSeconds) }),
      );
      break;
    case 'fourByFour':
      parts.push(
        t('mobile.session.preGeneratorBlockSummaryRepsBySets', { reps: options.repsPerSet, count: options.sets }),
      );
      // No rest between reps is the default, and says nothing worth a part.
      if (options.restBetweenRepsSeconds > 0) {
        parts.push(
          t('mobile.session.preGeneratorBlockSummaryRepRest', {
            value: formatRestLength(options.restBetweenRepsSeconds),
          }),
        );
      }
      if (options.restBetweenSetsSeconds > 0) {
        parts.push(
          t('mobile.session.preGeneratorBlockSummarySetRest', {
            value: formatRestLength(options.restBetweenSetsSeconds),
          }),
        );
      }
      break;
    case 'limitBouldering':
      parts.push(t('mobile.session.preGeneratorBlockSummaryClimbs', { count: options.numberOfClimbs }));
      if (options.restSeconds > 0) {
        parts.push(t('mobile.session.preGeneratorBlockSummaryRest', { value: formatRestLength(options.restSeconds) }));
      }
      break;
    default: {
      // A void switch would let a new type through with no summary; this fails to compile instead.
      const exhaustiveOptions: never = options;
      void exhaustiveOptions;
    }
  }
  return parts;
}

type WorkoutBlockCardProps = {
  block: WorkoutBlock;
  /** 1-based place in the workout. */
  position: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  expanded: boolean;
  /** For a warm-up: the grade of the workout block it ramps to, null when none follows. */
  warmUpTargetGrade: number | null;
  /** For a warm-up: that block's 1-based number. */
  warmUpTargetBlockNumber: number | null;
  /** For a warm-up after the last workout block: the grade of the block before it, which it eases off from. */
  coolDownFromGrade: number | null;
  /** For that warm-up: that block's 1-based number. */
  coolDownFromBlockNumber: number | null;
  boardName: BoardName | null;
  railGrades: readonly Grade[];
  /** Which size filters the board offers. Keep its identity stable: the card is memoised. */
  sizeFilters: SizeFilterAvailability;
  onToggle: (blockId: string) => void;
  onTypeChange: (blockId: string, type: WorkoutBlockType) => void;
  onBlockChange: (blockId: string, spec: WorkoutBlockSpec) => void;
  onFiltersChange: (blockId: string, patch: Partial<WorkoutFilters>) => void;
  onMove: (blockId: string, direction: MoveDirection) => void;
  onRemove: (blockId: string) => void;
  /** Fires on every layout of the card, so the list can scroll a freshly opened card into view. */
  onCardLayout: (blockId: string, cardView: View) => void;
};

export const WorkoutBlockCard = memo(function WorkoutBlockCard({
  block,
  position,
  canMoveUp,
  canMoveDown,
  expanded,
  warmUpTargetGrade,
  warmUpTargetBlockNumber,
  coolDownFromGrade,
  coolDownFromBlockNumber,
  boardName,
  railGrades,
  sizeFilters,
  onToggle,
  onTypeChange,
  onBlockChange,
  onFiltersChange,
  onMove,
  onRemove,
  onCardLayout,
}: WorkoutBlockCardProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const cardRef = useRef<View>(null);
  const blockId = block.id;
  const title = t('mobile.session.preGeneratorBlockTitle', { position });
  const typeName = workoutStageName(blockType(block), t);

  const summary = useMemo(() => {
    const warmUpRamp: WarmUpRamp | null =
      warmUpTargetGrade != null
        ? { direction: 'up', grade: warmUpTargetGrade }
        : coolDownFromGrade != null
          ? { direction: 'down', grade: coolDownFromGrade }
          : null;
    return blockSummary(
      block,
      (difficultyId) => formatGradeByDifficultyId(difficultyId, boardName) ?? String(difficultyId),
      warmUpRamp,
      t,
      !sameFilters(block.filters, DEFAULT_WORKOUT_FILTERS),
    );
  }, [block, formatGradeByDifficultyId, boardName, warmUpTargetGrade, coolDownFromGrade, t]);

  // Stable per block, so the fields don't get new handlers on every render.
  const handleToggle = useCallback(() => {
    hapticSelection();
    onToggle(blockId);
  }, [onToggle, blockId]);
  const handleTypeChange = useCallback(
    (type: WorkoutBlockType) => onTypeChange(blockId, type),
    [onTypeChange, blockId],
  );
  const handleBlockChange = useCallback(
    (spec: WorkoutBlockSpec) => onBlockChange(blockId, spec),
    [onBlockChange, blockId],
  );
  const handleFiltersChange = useCallback(
    (patch: Partial<WorkoutFilters>) => onFiltersChange(blockId, patch),
    [onFiltersChange, blockId],
  );
  const handleLayout = useCallback(() => {
    if (cardRef.current) onCardLayout(blockId, cardRef.current);
  }, [onCardLayout, blockId]);

  // Moves that can't happen are left out of the menu rather than greyed.
  const availableActions = useMemo(() => {
    const actions: BlockAction[] = [];
    if (canMoveUp) actions.push('moveUp');
    if (canMoveDown) actions.push('moveDown');
    actions.push('remove');
    return actions;
  }, [canMoveUp, canMoveDown]);

  const runAction = useCallback(
    (action: BlockAction) => {
      hapticSelection();
      if (action === 'remove') onRemove(blockId);
      else onMove(blockId, action === 'moveUp' ? 'up' : 'down');
    },
    [onMove, onRemove, blockId],
  );

  const menuActions = useMemo<AppMenuAction[]>(
    () =>
      availableActions.map((action) => {
        switch (action) {
          case 'moveUp':
            return { label: t('mobile.session.preGeneratorMoveBlockUp'), systemIcon: 'arrow.up' };
          case 'moveDown':
            return { label: t('mobile.session.preGeneratorMoveBlockDown'), systemIcon: 'arrow.down' };
          case 'remove':
            return { label: t('mobile.session.preGeneratorRemoveBlock'), systemIcon: 'trash', destructive: true };
        }
      }),
    [availableActions, t],
  );
  const handleMenuSelect = useCallback(
    (index: number) => {
      const action = availableActions[index];
      if (action) runAction(action);
    },
    [availableActions, runAction],
  );

  // The same moves for VoiceOver and TalkBack, on the header itself.
  const accessibilityActions = useMemo(
    () =>
      availableActions.map((action) => {
        switch (action) {
          case 'moveUp':
            return { name: action, label: t('mobile.session.preGeneratorMoveBlockUpAccessibilityLabel', { position }) };
          case 'moveDown':
            return {
              name: action,
              label: t('mobile.session.preGeneratorMoveBlockDownAccessibilityLabel', { position }),
            };
          case 'remove':
            return { name: action, label: t('mobile.session.preGeneratorRemoveBlockAccessibilityLabel', { position }) };
        }
      }),
    [availableActions, position, t],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const action = availableActions.find((available) => available === event.nativeEvent.actionName);
      if (action) runAction(action);
    },
    [availableActions, runAction],
  );

  const headerLabel = t('mobile.session.preGeneratorBlockHeaderAccessibilityLabel', { position, type: typeName });

  return (
    <View ref={cardRef} onLayout={handleLayout} collapsable={false} testID={`workout-block-${position}`}>
      <Card>
        {/* The menu sits BETWEEN two toggle targets rather than inside one, so its
            taps never fold the card (the CollapsibleSection pattern). */}
        <View style={styles.header}>
          <PressableSurface
            onPress={handleToggle}
            accessibilityRole="button"
            accessibilityLabel={expanded ? headerLabel : `${headerLabel}. ${summary}`}
            accessibilityState={{ expanded }}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={handleAccessibilityAction}
            style={styles.headerPress}
          >
            <View style={[styles.badge, { backgroundColor: systemColors.tertiaryFill }]}>
              <Text variant="footnote" numeric style={styles.badgeText}>
                {position}
              </Text>
            </View>
            <View style={styles.headerText}>
              <Text variant="headline" numberOfLines={1}>
                {typeName}
              </Text>
              {/* Two lines: a 4x4 with both rests ("V2 · 3 reps × 2 sets · 0:20
                  between sets") is longer than one line on a 6.3-inch phone. */}
              {expanded ? null : (
                <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={2}>
                  {summary}
                </Text>
              )}
            </View>
          </PressableSurface>
          <AppMenu
            iconName="more"
            iconAppearance="plain"
            anchorSize={44}
            accessibilityLabel={t('mobile.session.preGeneratorBlockActionsAccessibilityLabel', { position })}
            actions={menuActions}
            onSelectIndex={handleMenuSelect}
          />
          <PressableSurface
            onPress={handleToggle}
            // The header button already announces the card and its state.
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={styles.chevron}
          >
            <SectionDisclosureChevron expanded={expanded} />
          </PressableSurface>
        </View>

        {expanded ? (
          <View style={styles.body}>
            <WorkoutBlockFields
              block={block}
              boardName={boardName}
              railGrades={railGrades}
              groupLabel={title}
              warmUpTargetGrade={warmUpTargetGrade}
              warmUpTargetBlockNumber={warmUpTargetBlockNumber}
              coolDownFromGrade={coolDownFromGrade}
              coolDownFromBlockNumber={coolDownFromBlockNumber}
              filters={block.filters}
              sizeFilters={sizeFilters}
              onTypeChange={handleTypeChange}
              onBlockChange={handleBlockChange}
              onFiltersChange={handleFiltersChange}
            />
          </View>
        ) : null}
      </Card>
    </View>
  );
});

const styles = StyleSheet.create({
  // The Card pads 16pt; pulling the header up and down by a little keeps its
  // row a 52pt target without a tall empty band above the type name.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    marginVertical: -spacing[2],
  },
  headerPress: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 52,
  },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontWeight: '600',
  },
  headerText: {
    flex: 1,
  },
  chevron: {
    width: 32,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  body: {
    marginTop: spacing[4],
  },
});
