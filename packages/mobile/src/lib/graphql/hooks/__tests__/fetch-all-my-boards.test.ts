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
import type { GetProfileQueryResponse } from '../../operations';

const requestMock = vi.fn();
const authGeneration = vi.hoisted(() => ({ value: 1 }));
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => authGeneration.value,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === authGeneration.value,
}));

import { fetchAllMyBoards } from '../fetch-all-my-boards';
import { fetchAllMyOwnedBoards } from '../fetch-all-my-owned-boards';
import { GET_MY_BOARDS, GET_PROFILE } from '../../operations';

/** A `myBoards` page whose rows carry distinct uuids, so ordering is assertable. */
function myBoardsPage(count: number, hasMore: boolean, firstIndex = 0) {
  const boards = Array.from(
    { length: count },
    (_, index) => ({ uuid: `board-${firstIndex + index}`, ownerId: 'viewer-1' }) as unknown as UserBoard,
  );
  return { myBoards: { boards, totalCount: count, hasMore } };
}

function boardRow(uuid: string, ownerId: string, isOwned: boolean): UserBoard {
  return { uuid, ownerId, isOwned } as unknown as UserBoard;
}

function profileResponse(id: string | null): GetProfileQueryResponse {
  return { profile: id ? ({ id } as GetProfileQueryResponse['profile']) : null };
}

beforeEach(() => {
  requestMock.mockReset();
  authGeneration.value = 1;
});

describe('fetchAllMyBoards', () => {
  // The first page is deliberately SHORT (30 rows, `hasMore` still set) — a
  // full-page fixture can't tell "offset += rows received" apart from
  // "offset = page * limit", and the server is free to return fewer rows than
  // asked for. Getting that wrong silently skips or repeats boards.
  it('walks every page until hasMore clears, advancing the offset by rows received', async () => {
    requestMock.mockResolvedValueOnce(myBoardsPage(30, true)).mockResolvedValueOnce(myBoardsPage(3, false, 30));

    const boards = await fetchAllMyBoards();

    expect(boards).toHaveLength(33);
    expect(boards[32].uuid).toBe('board-32');
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenNthCalledWith(1, GET_MY_BOARDS, { input: { limit: 50, offset: 0 } });
    expect(requestMock).toHaveBeenNthCalledWith(2, GET_MY_BOARDS, { input: { limit: 50, offset: 30 } });
  });

  it('asks once when the first page is the whole list', async () => {
    requestMock.mockResolvedValueOnce(myBoardsPage(2, false));

    const boards = await fetchAllMyBoards();

    expect(boards).toHaveLength(2);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  // A server that always claims another page would loop against a fixed offset.
  it('stops at the page cap and returns what it collected', async () => {
    requestMock.mockResolvedValue(myBoardsPage(50, true));

    const boards = await fetchAllMyBoards();

    expect(requestMock).toHaveBeenCalledTimes(20);
    expect(boards).toHaveLength(1000);
  });

  // An empty page with `hasMore` still set is the same runaway in slower motion:
  // the offset can't advance, so the next request repeats this one.
  it('stops on an empty page even when hasMore stays set', async () => {
    requestMock.mockResolvedValueOnce(myBoardsPage(50, true)).mockResolvedValue(myBoardsPage(0, true));

    const boards = await fetchAllMyBoards();

    expect(boards).toHaveLength(50);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejected page to the caller', async () => {
    requestMock.mockRejectedValue(new Error('offline'));

    await expect(fetchAllMyBoards()).rejects.toThrow('offline');
  });
});

describe('fetchAllMyOwnedBoards', () => {
  it('walks all pages and filters by authenticated ownerId, independent of isOwned', async () => {
    const followedPhysicalWall = boardRow('followed-first', 'another-viewer', true);
    const viewerBoardOnNextPage = boardRow('viewer-wall', 'viewer-1', false);
    requestMock
      .mockResolvedValueOnce(profileResponse('viewer-1'))
      .mockResolvedValueOnce({ myBoards: { boards: [followedPhysicalWall], totalCount: 2, hasMore: true } })
      .mockResolvedValueOnce({ myBoards: { boards: [viewerBoardOnNextPage], totalCount: 2, hasMore: false } })
      .mockResolvedValueOnce(profileResponse('viewer-1'));

    const result = await fetchAllMyOwnedBoards();

    expect(result).toEqual({ viewerId: 'viewer-1', boards: [viewerBoardOnNextPage] });
    expect(requestMock).toHaveBeenNthCalledWith(1, GET_PROFILE);
    expect(requestMock).toHaveBeenNthCalledWith(2, GET_MY_BOARDS, { input: { limit: 50, offset: 0 } });
    expect(requestMock).toHaveBeenNthCalledWith(3, GET_MY_BOARDS, { input: { limit: 50, offset: 1 } });
    expect(requestMock).toHaveBeenNthCalledWith(4, GET_PROFILE);
  });

  it('stops before the board-list request when the authenticated profile is missing', async () => {
    requestMock.mockResolvedValueOnce(profileResponse(null));

    await expect(fetchAllMyOwnedBoards()).rejects.toThrow(/verify the signed-in owner/);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(GET_PROFILE);
  });

  it('rejects the list when the authenticated account changes during pagination', async () => {
    requestMock
      .mockResolvedValueOnce(profileResponse('viewer-1'))
      .mockResolvedValueOnce({ myBoards: { boards: [], totalCount: 0, hasMore: false } })
      .mockResolvedValueOnce(profileResponse('viewer-2'));

    await expect(fetchAllMyOwnedBoards()).rejects.toThrow(/account changed/);
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('rejects credentials that switch away and back during a page request', async () => {
    requestMock.mockResolvedValueOnce(profileResponse('viewer-1')).mockImplementationOnce(async () => {
      // The numeric generation is monotonic, so this also models an A→B→A
      // account transition whose final profile ID alone would look unchanged.
      authGeneration.value += 1;
      authGeneration.value += 1;
      return { myBoards: { boards: [], totalCount: 0, hasMore: true } };
    });

    await expect(fetchAllMyOwnedBoards()).rejects.toThrow(/Authentication changed/);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('rejects rows without an owner instead of treating them as a verified empty rack', async () => {
    requestMock
      .mockResolvedValueOnce(profileResponse('viewer-1'))
      .mockResolvedValueOnce({
        myBoards: { boards: [boardRow('missing-owner', '', true)], totalCount: 1, hasMore: false },
      })
      .mockResolvedValueOnce(profileResponse('viewer-1'));

    await expect(fetchAllMyOwnedBoards()).rejects.toThrow(/verify ownership/);
  });
});
