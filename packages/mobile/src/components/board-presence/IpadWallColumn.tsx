import { memo } from 'react';
import { NowOnTheWallPanel } from './NowOnTheWallPanel';
import { useDrawerHost } from '../../providers/drawer-host-provider';

/**
 * The dedicated "Now on the wall" column on the iPad shell's trailing edge, shown
 * in landscape where there's room beside the browse list and the detail pane (see
 * `resolveWallSurface`). It renders the same wall feed / history / stats /
 * switch-board content as the BoardSheet modal, inline. The shell only mounts it
 * when a board is bound and the width budget allows, so the null case is just
 * defensive (no board resolved → nothing to show).
 */
function IpadWallColumnComponent() {
  const { boardPanelProps } = useDrawerHost();
  if (!boardPanelProps) return null;
  return <NowOnTheWallPanel variant="column" {...boardPanelProps} />;
}

export const IpadWallColumn = memo(IpadWallColumnComponent);
