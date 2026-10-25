import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../../lib/analytics';
import { SectionHeader } from '../../SectionHeader';
import { spacing } from '../../../theme/tokens';
import { sizeFilterAvailability } from './WorkoutBlockFilters';
import { clearUnavailableSizeFilters, hasWorkoutBlocks, type GeneratorSelection } from './workout-blocks';
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
  /** Scrolls a block card that was just added or opened clear of the bottom chrome. */
  onRevealBlock?: (cardView: ViewInstance) => void;
};

/**
 * The Workout section of the Record tab. With no blocks the climber picks every
 * climb; each block they add (a warm-up or a workout type) pre-fills the queue
 * from the shared `@boardsesh/playlist-generator`, in the order the blocks run.
 * Each block carries its own climb filters (min ascents, min rating, climb bias,
 * tall/wide), folded at the bottom of its card.
 */
export function GeneratorPickerCard({
  boardName,
  layoutId,
  sizeId,
  angle,
  selection,
  onChange,
  onRevealBlock,
}: GeneratorPickerCardProps) {
  const { t } = useTranslation('session');

  const { tall, wide } = sizeFilterAvailability(boardName, layoutId, sizeId);
  // Primitives as deps, so the memoised cards keep one object until the board changes.
  const sizeFilters = useMemo(() => ({ tall, wide }), [tall, wide]);

  // A board without smaller sizes can't honour tall/wide: switch them off on
  // every block, so a hidden switch never filters the preview.
  useEffect(() => {
    const cleared = clearUnavailableSizeFilters(selection, sizeFilters);
    if (cleared !== selection) onChange(cleared);
  }, [selection, sizeFilters, onChange]);

  // Adding the first block reveals the workout builder — the mobile analogue of
  // web's `Workout Generator Opened`. Match web's exact payload
  // (playlist-generator-drawer.tsx): `{ targetType, boardName, angle }`. The
  // pre-session flow always feeds the session queue, so targetType is 'session';
  // PostHog groups by exact prop name, so the keys must line up.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const handleBlocksChange = useCallback(
    (next: GeneratorSelection) => {
      if (!hasWorkoutBlocks(selectionRef.current) && hasWorkoutBlocks(next)) {
        track(SHARED_EVENTS.WorkoutGeneratorOpened, { targetType: 'session', boardName, angle });
      }
      onChange(next);
    },
    [angle, boardName, onChange],
  );

  return (
    <View>
      <SectionHeader title={t('mobile.session.preGeneratorLabel')} />
      <View style={styles.inset}>
        <WorkoutBlockList
          boardName={boardName}
          sizeFilters={sizeFilters}
          selection={selection}
          onChange={handleBlocksChange}
          onRevealBlock={onRevealBlock}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // SectionHeader brings its own 16px inset; matching horizontal padding lines
  // the cards up with the screen's other cards and section headers.
  inset: {
    paddingHorizontal: spacing[4],
  },
});
