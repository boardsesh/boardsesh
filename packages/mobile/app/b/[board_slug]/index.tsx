import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../src/components/BoardRouteRedirect';
import { buildSlugListTarget } from '../../../src/lib/routing/board-route-target';

/**
 * `/b/{slug}` — a named board with no angle in the URL, so the board's own
 * stored angle is the one the user lands on.
 */
export default function NamedBoardRoute() {
  const { board_slug } = useLocalSearchParams<{ board_slug?: string }>();
  const target = useMemo(() => buildSlugListTarget(board_slug), [board_slug]);

  return <BoardRouteHandoff target={target} />;
}
