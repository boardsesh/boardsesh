import { canEditClimb } from '@boardsesh/create-climb-react';
import { getBoardCapabilities } from '@boardsesh/board-config';
import type { Climb } from '@boardsesh/shared-schema';
import { useProfile } from '../../lib/graphql/hooks';
import { useSprayWallViewerCanEditClimbs } from '../../lib/spray/use-spray-wall';

/**
 * Whether the play drawer may offer Edit on the climb it is showing.
 *
 * The same rule, with the same inputs, as the climb-actions menu
 * (`use-climb-actions.ts`): `canEditClimb` decides, gated on the board being
 * one climbs are set on. The lost-holds banner uses it (#6024) so the setter or
 * a wall editor can fix a climb that lost holds in a reset as a new revision,
 * not only remix it. A hint, not a permission: `updateClimb` decides.
 */
export function useCanEditDisplayedClimb(
  climb: Climb | null | undefined,
  boardName: string,
  layoutId: number,
): boolean {
  const { data: profile } = useProfile();
  const viewerCanEditClimbs = useSprayWallViewerCanEditClimbs(boardName, layoutId);
  if (!climb) return false;
  return (
    getBoardCapabilities(boardName).climbCreation &&
    canEditClimb({
      climb,
      boardType: boardName,
      currentUserId: profile?.id ?? null,
      viewerCanEditClimbs,
      wallLayoutId: layoutId,
    })
  );
}
