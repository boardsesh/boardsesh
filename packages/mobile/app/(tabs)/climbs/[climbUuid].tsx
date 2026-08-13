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
};

/**
 * The standalone climb page is gone — every climb opens in the play drawer. This
 * route survives only as a deep-link / fallback target (the `ref` branch of
 * `openClimbInPlayDrawer` routes here when a caller has a uuid but no frames).
 * Its query-param contract is the older, flat one; the canonical board URLs live
 * under `app/[board_name]/…` and `app/b/[board_slug]/…`. All four share one
 * hand-off path.
 *
 * `mode="in-app"`: the config comes from the app, not from a user's link, so the
 * board is used as given rather than adopted — tapping a tick from someone
 * else's wall must not switch (or mint) the user's active board — and the
 * redirector pops back where it came from.
 */
export default function ClimbDetail() {
  const { climbUuid, boardName, layoutId, sizeId, setIds, angle } = useLocalSearchParams<ClimbDetailParams>();

  const target = useMemo(
    () => buildBoardClimbTarget({ boardName, layoutId, sizeId, setIds, angle }, 'view', climbUuid),
    [climbUuid, boardName, layoutId, sizeId, setIds, angle],
  );

  return <BoardRouteHandoff target={target} mode="in-app" />;
}
