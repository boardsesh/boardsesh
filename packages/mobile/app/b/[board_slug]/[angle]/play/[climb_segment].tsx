import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../../../src/components/BoardRouteRedirect';
import { buildSlugClimbTarget } from '../../../../../src/lib/routing/board-route-target';

type NamedBoardClimbRouteParams = {
  board_slug?: string;
  angle?: string;
  climb_segment?: string;
};

/** `/b/{slug}/{angle}/play/{climbSlug-uuid}` — same destination as `/view/…`. */
export default function NamedBoardClimbPlayRoute() {
  const { board_slug, angle, climb_segment } = useLocalSearchParams<NamedBoardClimbRouteParams>();
  const target = useMemo(
    () => buildSlugClimbTarget(board_slug, angle, climb_segment),
    [board_slug, angle, climb_segment],
  );

  return <BoardRouteHandoff target={target} />;
}
