'use client';

import { useSubscribeClimbStatsLayout } from '@/app/hooks/use-subscribe-climb-stats-layout';
import type { BoardName } from '@/app/lib/types';

/**
 * Invisible page-level mount point for the climb-stats WS subscription.
 *
 * One subscription per `(boardName, layoutId)` is opened for authenticated
 * users; incoming events are routed into the live-stats React Query cache,
 * which every `<ClimbTitle>` / `<ClimbDetailHeader>` / `<AngleCard>` on the
 * page already reads from. Anonymous users get a no-op (the hook
 * short-circuits).
 *
 * Renders no DOM. Mount near the top of board-scoped layouts where
 * `boardName` and `layoutId` are both resolved from the route.
 */
export function ClimbStatsLayoutSubscriber({ boardName, layoutId }: { boardName: BoardName; layoutId: number }) {
  useSubscribeClimbStatsLayout(boardName, layoutId);
  return null;
}
