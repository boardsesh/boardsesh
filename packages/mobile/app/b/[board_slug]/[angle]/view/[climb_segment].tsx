import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../../../src/components/BoardRouteRedirect';
import { buildSlugClimbTarget } from '../../../../../src/lib/routing/board-route-target';

type NamedBoardClimbRouteParams = {
  board_slug?: string;
  angle?: string;
  climb_segment?: string;
};

/**
 * `/b/{slug}/{angle}/view/{climbSlug-uuid}` — a climb on a named board. The
 * board carries no config in the URL, so it is resolved by slug first and the
 * climb is then loaded against it.
 */
export default function NamedBoardClimbViewRoute() {
  const { board_slug, angle, climb_segment } = useLocalSearchParams<NamedBoardClimbRouteParams>();
  const target = useMemo(
    () => buildSlugClimbTarget(board_slug, angle, climb_segment),
    [board_slug, angle, climb_segment],
  );

  return <BoardRouteHandoff target={target} />;
}
