import { useCallback, useState } from 'react';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useSetBoardAngle } from '../../lib/boards/use-set-board-angle';
import { hapticLight } from '../../lib/haptics';
import { canAdjustBoardAngle } from '../../lib/boards/can-adjust-board-angle';

/**
 * Angle state for `MaterialAngleAction`, Discover's Material app-bar angle: reads
 * the active board, owns the selector sheet's open state, and writes the chosen
 * angle back (re-grading the list).
 *
 * The Climbs filter-row Angle chip doesn't use this. It goes through
 * `BoardAnglePicker`, which also discards a picker left open across a board or
 * angle change.
 */
export function useMaterialAngleControl() {
  const { data: activeBoard } = useActiveBoard();
  const setBoardAngle = useSetBoardAngle();
  const [visible, setVisible] = useState(false);

  const canAdjust = canAdjustBoardAngle(activeBoard);
  const open = useCallback(() => {
    if (!canAdjustBoardAngle(activeBoard)) return;
    hapticLight();
    setVisible(true);
  }, [activeBoard]);
  const close = useCallback(() => setVisible(false), []);
  const change = useCallback(
    (newAngle: number) => {
      if (!canAdjustBoardAngle(activeBoard) || newAngle === activeBoard.angle) return;
      void setBoardAngle(activeBoard, newAngle);
    },
    [activeBoard, setBoardAngle],
  );

  return { activeBoard, canAdjust, visible, open, close, change };
}
