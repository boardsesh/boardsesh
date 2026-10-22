import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import type { WorkoutBlockSpec } from '@boardsesh/playlist-generator';
import { Card } from '../../Card';
import { Icon } from '../../Icon';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import { hapticSelection } from '../../../lib/haptics';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { getDefaultTargetGrade, toRailGrades } from './generator-controls';
import { WorkoutBlockCard } from './WorkoutBlockCard';
import {
  MAX_WORKOUT_BLOCKS,
  addBlock,
  canAddBlock,
  changeBlockType,
  moveBlock,
  removeBlock,
  updateBlock,
  updateBlockFilters,
  warmUpTarget,
  type GeneratorSelection,
  type SizeFilterAvailability,
  type WorkoutBlockType,
  type WorkoutFilters,
} from './workout-blocks';

// Block ids key the cards on this screen. Uuids, like the stage ids: a module
// counter restarts on a Fast Refresh while the selection in PreSessionView state
// survives it, and could hand a new block an id that is already in use.
const makeBlockId = () => randomUUID();

type WorkoutBlockListProps = {
  boardName: BoardName | null;
  /** Which size filters the board offers. Keep its identity stable: the cards are memoised. */
  sizeFilters: SizeFilterAvailability;
  selection: GeneratorSelection;
  onChange: (selection: GeneratorSelection) => void;
  /** Scrolls a card that was just added or opened clear of the bottom chrome. */
  onRevealBlock?: (cardView: View) => void;
};

/**
 * The workout's blocks in run order, or a note that there is no workout yet,
 * then "Add a block". One card is open at a time and a new block opens on add.
 * Which card is open is this list's own state, not part of the selection, so
 * opening one never rebuilds the preview.
 */
export function WorkoutBlockList({
  boardName,
  sizeFilters,
  selection,
  onChange,
  onRevealBlock,
}: WorkoutBlockListProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const railGrades = useMemo(() => toRailGrades(boardName), [boardName]);
  // Screenshot mode starts with a block; show it open.
  const [expandedBlockId, setExpandedBlockId] = useState<string | null>(() => selection.blocks[0]?.id ?? null);
  // The card to scroll into view on its next layout, once it has opened.
  const pendingRevealIdRef = useRef<string | null>(null);

  // The cards' callbacks read the latest values through refs, so they keep one
  // identity across edits and the memoised cards only re-render when their own
  // block changes.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const expandedBlockIdRef = useRef(expandedBlockId);
  expandedBlockIdRef.current = expandedBlockId;
  const fallbackGradeRef = useRef(getDefaultTargetGrade(boardName));
  fallbackGradeRef.current = getDefaultTargetGrade(boardName);
  const onRevealBlockRef = useRef(onRevealBlock);
  onRevealBlockRef.current = onRevealBlock;

  const handleToggle = useCallback((blockId: string) => {
    const opening = expandedBlockIdRef.current !== blockId;
    if (opening) pendingRevealIdRef.current = blockId;
    setExpandedBlockId(opening ? blockId : null);
  }, []);
  const handleTypeChange = useCallback(
    (blockId: string, type: WorkoutBlockType) =>
      onChange(changeBlockType(selectionRef.current, blockId, type, fallbackGradeRef.current)),
    [onChange],
  );
  const handleBlockChange = useCallback(
    (blockId: string, spec: WorkoutBlockSpec) => onChange(updateBlock(selectionRef.current, blockId, spec)),
    [onChange],
  );
  const handleFiltersChange = useCallback(
    (blockId: string, patch: Partial<WorkoutFilters>) =>
      onChange(updateBlockFilters(selectionRef.current, blockId, patch)),
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
    const blockId = makeBlockId();
    const next = addBlock(selectionRef.current, () => blockId, fallbackGradeRef.current);
    if (next === selectionRef.current) return;
    pendingRevealIdRef.current = blockId;
    setExpandedBlockId(blockId);
    onChange(next);
  }, [onChange]);
  const handleCardLayout = useCallback((blockId: string, cardView: View) => {
    if (pendingRevealIdRef.current !== blockId) return;
    pendingRevealIdRef.current = null;
    onRevealBlockRef.current?.(cardView);
  }, []);

  const { blocks } = selection;
  const canAdd = canAddBlock(selection);
  const addLabel = canAdd
    ? t('mobile.session.preGeneratorAddBlock')
    : t('mobile.session.preGeneratorBlockLimit', { max: MAX_WORKOUT_BLOCKS });
  // At the cap the row stays put and greys out, saying why.
  const addColor = canAdd ? brandColors.primary : systemColors.secondaryLabel;

  return (
    <View style={styles.list}>
      {blocks.length === 0 ? (
        <Card>
          <Text variant="body" color={systemColors.secondaryLabel}>
            {t('mobile.session.preGeneratorEmpty')}
          </Text>
        </Card>
      ) : (
        blocks.map((block, position) => {
          const target = block.kind === 'warmUp' ? warmUpTarget(blocks, position) : null;
          return (
            <WorkoutBlockCard
              key={block.id}
              block={block}
              position={position + 1}
              canMoveUp={position > 0}
              canMoveDown={position < blocks.length - 1}
              expanded={block.id === expandedBlockId}
              warmUpTargetGrade={target?.targetGrade ?? null}
              warmUpTargetBlockNumber={target?.blockNumber ?? null}
              boardName={boardName}
              railGrades={railGrades}
              sizeFilters={sizeFilters}
              onToggle={handleToggle}
              onTypeChange={handleTypeChange}
              onBlockChange={handleBlockChange}
              onFiltersChange={handleFiltersChange}
              onMove={handleMove}
              onRemove={handleRemove}
              onCardLayout={handleCardLayout}
            />
          );
        })
      )}

      <PressableSurface
        onPress={handleAdd}
        disabled={!canAdd}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={addLabel}
        accessibilityHint={canAdd ? t('mobile.session.preGeneratorAddBlockHint') : undefined}
        accessibilityState={{ disabled: !canAdd }}
        style={styles.addRow}
      >
        <Icon name="add" size={18} color={addColor} />
        <Text variant="subheadline" color={addColor} style={styles.addText}>
          {addLabel}
        </Text>
      </PressableSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: spacing[3],
  },
  // Full width, so the whole row is the target, not just its label.
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    minHeight: 44,
  },
  addText: {
    fontWeight: '600',
  },
});
