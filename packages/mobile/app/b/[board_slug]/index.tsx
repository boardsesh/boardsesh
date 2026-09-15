import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../src/components/BoardRouteRedirect';
import { buildSlugListTarget } from '../../../src/lib/routing/board-route-target';
import { useSprayWallFromLink } from '../../../src/lib/spray/use-spray-wall-link';

/**
 * `/b/{slug}` — a named board with no angle in the URL, so the board's own
 * stored angle is the one the user lands on.
 */
export default function NamedBoardRoute() {
  const { board_slug, wall } = useLocalSearchParams<{ board_slug?: string; wall?: string }>();
  const target = useMemo(() => buildSlugListTarget(board_slug), [board_slug]);

  // A spray share link's capability. Redeemed before the board resolves its wall,
  // so an unlisted wall is already in cache by the time anything asks for it.
  useSprayWallFromLink(wall);

  return <BoardRouteHandoff target={target} />;
}
