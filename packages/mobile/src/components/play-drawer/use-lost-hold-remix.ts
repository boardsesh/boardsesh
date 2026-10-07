import { useCallback, useEffect } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import { climbRemixedFromBroken } from '@boardsesh/analytics';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { useCreateClimbNavigation, type DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import { useSprayWallIsArchived } from '../../lib/spray/use-spray-wall-archive';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';

type UseLostHoldRemixArgs = {
  displayedClimb: Climb | null | undefined;
  renderBoardConfig: BoardConfig;
  dismissPlayerAndWait?: DismissSurfaceAndWait;
};

/**
 * The play drawer's "This climb lost a hold" banner: how many holds the shown
 * climb lost, and its one action, Remix (`null` on an archived wall, which takes
 * no new climb).
 *
 * Remix is the climb actions' own handoff (`useCreateClimbNavigation`: one
 * accepted action that dismisses the player, waits for the native transition,
 * then pushes the create route), so there is one place for that ordering. The
 * editor opens without the lost holds and draws a grey ring where each one was.
 * `Climb Remixed From Broken` fires when the action is accepted, so a tap the
 * guard swallows counts nothing. The guard is let go whenever another climb is
 * shown, as well as after each handoff.
 */
export function useLostHoldRemix({ displayedClimb, renderBoardConfig, dismissPlayerAndWait }: UseLostHoldRemixArgs): {
  lostHoldCount: number;
  onRemix: (() => void) | null;
} {
  const { openRemix, resetActionGuard } = useCreateClimbNavigation({ dismissPlayerAndWait });
  const lostHoldCount = displayedClimb?.missingHoldCount ?? 0;
  const wallArchived = useSprayWallIsArchived(renderBoardConfig.boardName, renderBoardConfig.layoutId);
  const climbUuid = displayedClimb?.uuid;
  useEffect(() => {
    resetActionGuard();
  }, [climbUuid, resetActionGuard]);

  const remix = useCallback(() => {
    if (!displayedClimb) return;
    openRemix(displayedClimb, renderBoardConfig, () =>
      trackSprayEvent(climbRemixedFromBroken({ lostHoldCount, source: 'play_drawer' })),
    );
  }, [displayedClimb, renderBoardConfig, openRemix, lostHoldCount]);

  return { lostHoldCount, onRemix: wallArchived ? null : remix };
}
