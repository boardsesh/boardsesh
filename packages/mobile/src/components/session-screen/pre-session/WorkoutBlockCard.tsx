// One workout block on the Record tab: a header with its number, its type, a
// ⋯ menu to move or remove it and a disclosure chevron, then its fields while
// open. Warm-ups and workouts share this card, so every block reads the same.

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
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { WorkoutBlockFields, warmUpLengthLabel } from './WorkoutBlockFields';
import { blockType, type WorkoutBlock, type WorkoutBlockType } from './workout-blocks';

type Translate = (key: string, options?: Record<string, string | number>) => string;
type MoveDirection = 'up' | 'down';
type BlockAction = 'moveUp' | 'moveDown' | 'remove';

/**
 * The one-line summary under a closed card's type: `V6 · 20 climbs · spread 0`
 * for a workout, `Standard · ramps to V6` for a warm-up.
 */
export function blockSummary(
  block: WorkoutBlockSpec,
  formatGrade: (difficultyId: number) => string,
  warmUpTargetGrade: number | null,
  t: Translate,
): string {
  if (block.kind === 'warmUp') {
    const target =
      warmUpTargetGrade != null
        ? t('mobile.session.preGeneratorWarmUpSummaryRamps', { grade: formatGrade(warmUpTargetGrade) })
        : t('mobile.session.preGeneratorWarmUpSummaryNoTarget');
    return [warmUpLengthLabel(block.warmUpType, t), target].join(' · ');
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
      break;
    case 'gradeFocus':
      parts.push(t('mobile.session.preGeneratorBlockSummaryClimbs', { count: options.numberOfClimbs }));
      break;
  }
  return parts.join(' · ');
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
  boardName: BoardName | null;
  railGrades: readonly Grade[];
  onToggle: (blockId: string) => void;
  onTypeChange: (blockId: string, type: WorkoutBlockType) => void;
  onBlockChange: (blockId: string, spec: WorkoutBlockSpec) => void;
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
  boardName,
  railGrades,
  onToggle,
  onTypeChange,
  onBlockChange,
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

  const summary = useMemo(
    () =>
      blockSummary(
        block,
        (difficultyId) => formatGradeByDifficultyId(difficultyId, boardName) ?? String(difficultyId),
        warmUpTargetGrade,
        t,
      ),
    [block, formatGradeByDifficultyId, boardName, warmUpTargetGrade, t],
  );

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
              {expanded ? null : (
                <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
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
              onTypeChange={handleTypeChange}
              onBlockChange={handleBlockChange}
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
