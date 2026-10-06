import { useEffect, useMemo } from 'react';
import { parseClimbFrameHoldIds } from '@boardsesh/board-config';
import type { Climb } from '@boardsesh/shared-schema';
import { getSprayWall, refreshSprayWall, SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';

/**
 * Whether Edit on the lost-holds banner would open an editor that can save (#6024).
 *
 * The banner's count is the SERVER's (`missingHoldCount`). The editor drops lost
 * holds using the wall THIS DEVICE has registered (`getSprayWall`). The two can
 * disagree:
 *
 *  - `'wall-stale'`: the registered wall predates the reset (it is taken at face
 *    value for ten minutes, and React Query's stale window sits behind that), or
 *    no wall is registered yet. The editor would keep holds that are gone,
 *    painted but not drawn and not tappable, and the server would refuse Save.
 *  - `'nothing-left'`: every hold on the climb came off the wall. The editor
 *    would open blank with Save disabled and nothing saying why; Remix is the
 *    real answer there.
 *  - `'ready'`: the device's wall agrees with the server, and at least one hold
 *    is still on it.
 *
 * Holds the device thinks are gone but the server does not count (a climb row
 * older than the wall) are fine: the editor drops them and the save is valid.
 */
export type LostHoldsEditReadiness = 'ready' | 'wall-stale' | 'nothing-left';

export function lostHoldsEditReadiness(
  frames: string | null | undefined,
  serverLostCount: number,
  liveHoldIds: ReadonlySet<number> | null,
): LostHoldsEditReadiness {
  if (!liveHoldIds) return 'wall-stale';
  const climbHoldIds = new Set(parseClimbFrameHoldIds(frames));
  let lost = 0;
  for (const holdId of climbHoldIds) if (!liveHoldIds.has(holdId)) lost += 1;
  if (lost < serverLostCount) return 'wall-stale';
  if (lost >= climbHoldIds.size) return 'nothing-left';
  return 'ready';
}

/**
 * The hook form for the play drawer. Re-reads when the registered wall changes,
 * and when it is behind the server, asks for a fresh copy past both the
 * revalidation window and React Query's cache, so Edit appears once it lands.
 */
export function useLostHoldsEditReadiness(
  climb: Climb | null | undefined,
  boardName: string,
  layoutId: number,
): LostHoldsEditReadiness {
  const isSpray = boardName === SPRAY_BOARD_NAME;
  const wallToken = useSprayWallToken(boardName, layoutId);
  const frames = climb?.frames;
  const serverLostCount = climb?.missingHoldCount ?? 0;

  const readiness = useMemo(() => {
    if (!isSpray) return 'wall-stale' as const;
    const wall = getSprayWall(layoutId);
    const liveHoldIds = wall ? new Set(wall.holds.map((hold) => hold.id)) : null;
    return lostHoldsEditReadiness(frames, serverLostCount, liveHoldIds);
    // `wallToken` changes whenever the registered wall does; it is the reason to re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpray, layoutId, frames, serverLostCount, wallToken]);

  // Only a wall we HOLD but that is behind gets the forced refresh. An absent
  // wall is already being fetched by `useSprayWallToken`. Keyed on the token, so
  // a refresh that brings back the same version does not ask again.
  const wallHeldButBehind = isSpray && readiness === 'wall-stale' && getSprayWall(layoutId) !== null;
  useEffect(() => {
    if (wallHeldButBehind) refreshSprayWall(layoutId);
  }, [wallHeldButBehind, layoutId, wallToken]);

  return readiness;
}
