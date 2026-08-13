import type { UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { GET_MY_BOARDS, type GetMyBoardsQueryResponse } from '../operations';

/** The server's maximum `myBoards` page (`MyBoardsInputSchema`); its default is 20. */
const MY_BOARDS_PAGE_SIZE = 50;
/**
 * Runaway guard, not a real limit — 20 pages is 1000 boards, far past anyone's
 * rack (the backend's own duplicate scan stops at 100 rows per config). It only
 * exists so a server that never clears `hasMore` can't loop forever.
 */
const MY_BOARDS_MAX_PAGES = 20;

/**
 * Every board the signed-in user owns, imperatively, walking `myBoards` to the
 * end of its pagination.
 *
 * A caller that has to answer "does the user already own this config?" cannot
 * use `useMyBoards`: one page tops out at 50 rows (20 by default), so a board on
 * page two reads as no board at all and the caller mints a duplicate of gear the
 * user already has. Only the `hasMore` walk answers the question.
 *
 * Imperative rather than a query for a second reason: React Query runs
 * `networkMode: 'offlineFirst'`, so an awaited `refetch()` while offline pauses
 * its retryer and never settles — the awaiting caller hangs forever. A bare
 * request rejects, which a caller can turn into a visible failure.
 *
 * Hitting the page cap returns what was collected rather than throwing: a
 * partial list is still better input for owned-board reuse than none.
 */
export async function fetchAllMyBoards(): Promise<UserBoard[]> {
  const ownedBoards: UserBoard[] = [];
  for (let page = 0; page < MY_BOARDS_MAX_PAGES; page += 1) {
    const data = await getHttpClient().request<GetMyBoardsQueryResponse>(GET_MY_BOARDS, {
      input: { limit: MY_BOARDS_PAGE_SIZE, offset: ownedBoards.length },
    });
    ownedBoards.push(...data.myBoards.boards);
    // An empty page with `hasMore` still set would re-request the same offset
    // forever, so it ends the walk as surely as `hasMore: false` does.
    if (!data.myBoards.hasMore || data.myBoards.boards.length === 0) break;
  }
  return ownedBoards;
}
