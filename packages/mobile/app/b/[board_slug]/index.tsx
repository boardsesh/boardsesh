import { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BoardRouteHandoff } from '../../../src/components/BoardRouteRedirect';
import { buildSlugListTarget } from '../../../src/lib/routing/board-route-target';

/**
 * `/b/{slug}` — a named board with no angle in the URL, so the board's own
 * stored angle is the one the user lands on.
 *
 * `?invite=` is a home board's share link: the handoff asks the climber to
 * confirm Join, and joins the board before opening it, only if they do
 * (`redeem-board-share-link.ts`).
 */
export default function NamedBoardRoute() {
  const { board_slug, wall, invite } = useLocalSearchParams<{ board_slug?: string; wall?: string; invite?: string }>();
  const target = useMemo(() => buildSlugListTarget(board_slug), [board_slug]);

  return <BoardRouteHandoff target={target} wallUuid={wall} inviteToken={invite} />;
}
