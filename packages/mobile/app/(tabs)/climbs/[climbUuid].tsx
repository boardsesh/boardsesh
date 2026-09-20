import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../src/components/BoardRouteRedirect';
import { buildBoardClimbTarget } from '../../../src/lib/routing/board-route-target';

type ClimbDetailParams = {
  climbUuid: string;
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  activationIntent?: string | string[];
};

/**
 * The standalone climb page is gone — every climb opens in the play drawer. This
 * route survives only as a deep-link / fallback target (the `ref` branch of
 * `openClimbInPlayDrawer` routes here when a caller has a uuid but no frames).
 * Its query-param contract is the older, flat one; the canonical board URLs live
 * under `app/[board_name]/…` and `app/b/[board_slug]/…`. All four share one
 * hand-off path.
 *
 * Uses the supplied board without adopting it, for both internal and external
 * entries. Only a matching, unconsumed in-memory tick intent can activate a climb.
 */
export default function ClimbDetail() {
  const { climbUuid, boardName, layoutId, sizeId, setIds, angle, activationIntent } =
    useLocalSearchParams<ClimbDetailParams>();

  const target = useMemo(
    () => buildBoardClimbTarget({ boardName, layoutId, sizeId, setIds, angle }, 'view', climbUuid),
    [climbUuid, boardName, layoutId, sizeId, setIds, angle],
  );

  return <BoardRouteHandoff target={target} mode="in-app" activationIntent={activationIntent} />;
}
