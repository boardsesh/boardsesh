// Pins the `myBoards` pagination walk behind `fetchAllMyBoards`.
//
// The server pages `myBoards` at 50 rows, so a single-page read reports "you
// don't own this" for a board sitting on page two — which is how a canonical
// board URL ended up minting a duplicate of the user's own wall. The walk also
// has to stay bounded: a server that never clears `hasMore` must not spin the
// caller forever.
//
// Imports the helper module directly rather than the `hooks` barrel — the
// barrel statically reaches react-native's Flow source, which Rolldown's scan
// refuses (same reason `use-delete-account.test.tsx` imports its hook file).
// Mocks only the GraphQL client.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { fetchAllMyBoards } from '../fetch-all-my-boards';
import { GET_MY_BOARDS } from '../../operations';

/** A `myBoards` page whose rows carry distinct uuids, so ordering is assertable. */
function myBoardsPage(count: number, hasMore: boolean, firstIndex = 0) {
  const boards = Array.from(
    { length: count },
    (_, index) => ({ uuid: `board-${firstIndex + index}` }) as unknown as UserBoard,
  );
  return { myBoards: { boards, totalCount: count, hasMore } };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('fetchAllMyBoards', () => {
  it('walks every page until hasMore clears, advancing the offset by rows received', async () => {
    requestMock.mockResolvedValueOnce(myBoardsPage(50, true)).mockResolvedValueOnce(myBoardsPage(3, false, 50));

    const ownedBoards = await fetchAllMyBoards();

    expect(ownedBoards).toHaveLength(53);
    expect(ownedBoards[52].uuid).toBe('board-52');
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenNthCalledWith(1, GET_MY_BOARDS, { input: { limit: 50, offset: 0 } });
    expect(requestMock).toHaveBeenNthCalledWith(2, GET_MY_BOARDS, { input: { limit: 50, offset: 50 } });
  });

  it('asks once when the first page is the whole list', async () => {
    requestMock.mockResolvedValueOnce(myBoardsPage(2, false));

    const ownedBoards = await fetchAllMyBoards();

    expect(ownedBoards).toHaveLength(2);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  // A server that always claims another page would loop against a fixed offset.
  it('stops at the page cap and returns what it collected', async () => {
    requestMock.mockResolvedValue(myBoardsPage(50, true));

    const ownedBoards = await fetchAllMyBoards();

    expect(requestMock).toHaveBeenCalledTimes(20);
    expect(ownedBoards).toHaveLength(1000);
  });

  // An empty page with `hasMore` still set is the same runaway in slower motion:
  // the offset can't advance, so the next request repeats this one.
  it('stops on an empty page even when hasMore stays set', async () => {
    requestMock.mockResolvedValueOnce(myBoardsPage(50, true)).mockResolvedValue(myBoardsPage(0, true));

    const ownedBoards = await fetchAllMyBoards();

    expect(ownedBoards).toHaveLength(50);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejected page to the caller', async () => {
    requestMock.mockRejectedValue(new Error('offline'));

    await expect(fetchAllMyBoards()).rejects.toThrow('offline');
  });
});
