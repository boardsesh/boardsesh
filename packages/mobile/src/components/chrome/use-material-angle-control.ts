import { useCallback, useState } from 'react';
import { useActiveBoard, useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { hapticLight } from '../../lib/haptics';

/**
 * Shared angle state for the Material angle controls: reads the active board, owns
 * the selector sheet's open state, and writes the chosen angle back (re-grading the
 * list).
 *
 * Each consumer gets its OWN instance (and its own `visible` state) — that's by
 * design, not a bug: `MaterialAngleAction` (Discover's app bar) and the Climbs
 * filter-row angle chip never co-render on the same screen, so there is no shared
 * sheet-open state to diverge.
 */
export function useMaterialAngleControl() {
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const [visible, setVisible] = useState(false);

  const canAdjust = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  const open = useCallback(() => {
    if (!activeBoard || activeBoard.isAngleAdjustable === false || activeBoard.angle == null) return;
    hapticLight();
    setVisible(true);
  }, [activeBoard]);
  const close = useCallback(() => setVisible(false), []);
  const change = useCallback(
    (newAngle: number) => {
      if (!activeBoard || activeBoard.isAngleAdjustable === false || newAngle === activeBoard.angle) return;
      void setActiveBoard({ ...activeBoard, angle: newAngle });
    },
    [activeBoard, setActiveBoard],
  );

  return { activeBoard, canAdjust, visible, open, close, change };
}
