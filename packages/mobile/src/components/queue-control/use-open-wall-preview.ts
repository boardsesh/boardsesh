import { useCallback } from 'react';
import type { Climb } from '@boardsesh/queue';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { hapticLight } from '../../lib/haptics';

/**
 * Opens a wall climb (the one lit on the board, distinct from your queue head) as
 * a read-only "Now on the wall" preview in the play drawer. It's physically lit
 * right now, so there's no "set active" takeover — you're just looking at what's
 * on the wall (possibly a teammate's pick). Used by {@link WallStatusCapsule}.
 */
export function useOpenWallPreview(): (wallClimb: Climb) => void {
  const { openPlayDrawer } = useDrawerHost();
  return useCallback(
    (wallClimb: Climb) => {
      hapticLight();
      openPlayDrawer(wallClimb, {
        previewQueueItem: climbToQueueItem(wallClimb),
        previewIsWallClimb: true,
      });
    },
    [openPlayDrawer],
  );
}
