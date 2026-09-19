import 'server-only';
import { unstable_cache } from 'next/cache';
import { GET_BOARD_DISCOVERY, type GetBoardDiscoveryQueryResponse } from '@boardsesh/graphql/operations';
import type { BoardDiscoveryBoard, BoardDiscoveryInput } from '@boardsesh/shared-schema';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';

type DiscoverySnapshot = { boards: BoardDiscoveryBoard[]; fetchedAt: number };

const fetchBoardDiscovery = unstable_cache(
  async (gymUuid: string | null, limit: number): Promise<DiscoverySnapshot> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await executeGraphQLInternal<GetBoardDiscoveryQueryResponse>(
        GET_BOARD_DISCOVERY,
        { input: { ...(gymUuid ? { gymUuid } : {}), limit } },
        controller.signal,
      );
      return { boards: response.boardDiscovery, fetchedAt: Date.now() };
    } finally {
      clearTimeout(timer);
    }
  },
  ['public-physical-board-discovery'],
  // An anonymous snapshot, not a live session subscription. Arguments keep
  // each gym separate from the globally ranked selection.
  { revalidate: 30, tags: ['public-physical-board-discovery'] },
);

/** A failed optional preview must never take down the homepage or gym cards. */
export async function getBoardDiscovery(input: BoardDiscoveryInput = {}): Promise<BoardDiscoveryBoard[]> {
  try {
    const snapshot = await fetchBoardDiscovery(input.gymUuid ?? null, input.limit ?? 8);
    // Next can serve stale cache entries indefinitely when revalidation fails.
    // Never let an old selected climb (or subsequently private board) masquerade
    // as a recent public preview. A cold/failed revalidation costs this optional
    // section rather than extending that disclosure window beyond one minute.
    return Date.now() - snapshot.fetchedAt <= 60_000 ? snapshot.boards : [];
  } catch (error) {
    console.error('[home-page-ssr] boardDiscovery failed:', error instanceof Error ? error.message : 'unknown error');
    return [];
  }
}
