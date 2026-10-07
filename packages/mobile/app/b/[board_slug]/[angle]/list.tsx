import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../../src/components/BoardRouteRedirect';
import { buildSlugListTarget } from '../../../../src/lib/routing/board-route-target';

type NamedBoardListRouteParams = {
  board_slug?: string;
  angle?: string;
  /** A spray share link's capability — resolved during the board handoff. */
  wall?: string;
};

/** `/b/{slug}/{angle}/list` — a named board's climb list at a given angle. */
export default function NamedBoardListRoute() {
  const { board_slug, angle, wall } = useLocalSearchParams<NamedBoardListRouteParams>();
  const target = useMemo(() => buildSlugListTarget(board_slug, angle), [board_slug, angle]);

  return <BoardRouteHandoff target={target} wallUuid={wall} />;
}
