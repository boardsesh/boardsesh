import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { GET_BOARD_DISCOVERY, type GetBoardDiscoveryQueryResponse } from '@boardsesh/graphql/operations';
import type { BoardDiscoveryBoard, BoardDiscoveryInput } from '@boardsesh/shared-schema';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';

const fetchBoardDiscovery = async (gymUuid: string | null, limit: number): Promise<BoardDiscoveryBoard[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await executeGraphQLInternal<GetBoardDiscoveryQueryResponse>(
      GET_BOARD_DISCOVERY,
      { input: { ...(gymUuid ? { gymUuid } : {}), limit } },
      controller.signal,
    );
    return response.boardDiscovery;
  } finally {
    clearTimeout(timer);
  }
};

/** A failed optional preview must never take down the homepage or gym cards. */
export async function getBoardDiscovery(input: BoardDiscoveryInput = {}): Promise<BoardDiscoveryBoard[]> {
  try {
    // Board access can change at any time. Authorize every request and omit this
    // optional section when authorization is unavailable.
    return await fetchBoardDiscovery(input.gymUuid ?? null, input.limit ?? 8);
  } catch (error) {
    console.error('[home-page-ssr] boardDiscovery failed:', error instanceof Error ? error.message : 'unknown error');
    Sentry.captureException(error, { tags: { surface: 'board-discovery', operation: 'fetch' } });
    return [];
  }
}
