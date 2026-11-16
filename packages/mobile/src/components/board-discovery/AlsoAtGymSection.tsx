import type { UserBoard } from '@boardsesh/shared-schema';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { useGymBoards } from '../../lib/graphql/hooks/use-gym-boards';
import { GymWallSwitcher } from '../board-presence/GymWallSwitcher';
import { BoardSelectorSection } from './BoardSelectorView';

/**
 * "Also at {gym}": the other walls at the gym of `anchor` (the board in range,
 * else the board the climber is on; see `alsoAtGymAnchor`), one tap each,
 * under the picker's In range slot. The rows are the board sheet's own
 * GymWallSwitcher, so the walls read the same in both places. A tap binds that
 * wall like any pick; nothing connects without it (#7117).
 *
 * Renders nothing, title included, while the roster loads or when the gym has
 * no other wall. The switcher reads the same query, so this costs no second
 * request.
 */
export const AlsoAtGymSection = memo(function AlsoAtGymSection({
  anchor,
  onSelectBoard,
}: {
  anchor: UserBoard;
  onSelectBoard: (board: UserBoard) => void;
}) {
  const { t } = useTranslation('boards');
  const { data: gymBoards } = useGymBoards(anchor.gymUuid ?? null);
  const hasOtherWalls = (gymBoards ?? []).some((board) => board.uuid !== anchor.uuid);
  if (!hasOtherWalls || !anchor.gymName) return null;
  return (
    <BoardSelectorSection title={t('mobile.inRange.alsoAt', { gym: anchor.gymName })}>
      <GymWallSwitcher activeBoard={anchor} onSelectBoard={onSelectBoard} style={styles.switcher} />
    </BoardSelectorSection>
  );
});

const styles = StyleSheet.create({
  // The section header already spaces the rows from the title.
  switcher: {
    paddingTop: 0,
  },
});
