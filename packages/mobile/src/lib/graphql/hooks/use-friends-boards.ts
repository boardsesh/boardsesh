import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  GET_FRIENDS_BOARDS,
  type GetFriendsBoardsQueryResponse,
  type GetFriendsBoardsQueryVariables,
} from '@boardsesh/graphql/operations/boards';
import type { FriendBoardConnection } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { FRIENDS_BOARDS_QUERY_KEY } from '../friends-boards-key';

/**
 * Boards owned by the viewer's friends (`friendsBoards`: the owner and the
 * viewer follow each other), for "A friend's board" and the picker's Friends'
 * boards shelf. A friend always follows the owner, so a Followers board always
 * opens; only an opted-in Invite-only board comes as an ask.
 *
 * Network only, never persisted (docs/data/offline-reads.md, Bucket 3): the
 * list says who may climb where right now, and a stale copy would offer a
 * board the owner just took back. The persisted cache is an allowlist, so
 * leaving this key off it is the whole opt-out.
 *
 * The key root is `friendsBoards` (friends-boards-key.ts), which a privacy
 * write by the viewer (`refreshAfterOwnPrivacyChange`), the viewer's own follow
 * or unfollow, and a live `new_follower` or `board_access_approved`
 * notification refresh.
 */
export { FRIENDS_BOARDS_QUERY_KEY };

/** The server's page size for "A friend's board" (it allows 1 to 50). */
export const FRIENDS_BOARDS_PAGE_SIZE = 20;

async function requestFriendsBoards(
  variables: GetFriendsBoardsQueryVariables,
  signal: AbortSignal,
): Promise<FriendBoardConnection> {
  const response = await getHttpClient().request<GetFriendsBoardsQueryResponse>({
    document: GET_FRIENDS_BOARDS,
    variables,
    signal,
  });
  return response.friendsBoards;
}

/**
 * "A friend's board": one page per end-reach, filtered on the board or owner
 * name. `query` is the debounced, trimmed search; empty lists everyone.
 */
export function useFriendsBoards({
  viewerId,
  query,
  enabled,
}: {
  viewerId: string | undefined;
  query: string;
  enabled: boolean;
}) {
  return useInfiniteQuery({
    queryKey: [FRIENDS_BOARDS_QUERY_KEY, viewerId, 'list', query],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      requestFriendsBoards(
        { input: { query: query || null, limit: FRIENDS_BOARDS_PAGE_SIZE, offset: Number(pageParam) } },
        signal,
      ),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((sum, page) => sum + page.items.length, 0) : undefined,
    enabled: enabled && viewerId !== undefined,
  });
}

/**
 * The picker's shelf: one small page and no more. It shows five rows; one more
 * covers a board that is also in Your boards and gets deduped away.
 */
export const FRIENDS_BOARDS_SHELF_FETCH = 6;

export function useFriendsBoardsShelf({ viewerId, enabled }: { viewerId: string | undefined; enabled: boolean }) {
  return useQuery({
    queryKey: [FRIENDS_BOARDS_QUERY_KEY, viewerId, 'shelf'],
    queryFn: ({ signal }) => requestFriendsBoards({ input: { limit: FRIENDS_BOARDS_SHELF_FETCH, offset: 0 } }, signal),
    enabled: enabled && viewerId !== undefined,
  });
}
