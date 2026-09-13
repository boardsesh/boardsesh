// @vitest-environment jsdom
//
// The board switcher's data source. Three things here are load-bearing and all
// three fail quietly if they regress:
//   - a switcher rendered before the active board's gym resolves must not fire a
//     `gymBoards(gymUuid: null)` request at a resolver that is rate limited to
//     30/min shared with the board-presence reads on the same screen;
//   - the cache key has to be the one `useLinkBoardToGym` invalidates, or a
//     board that moved gyms keeps showing up under the old one;
//   - the cached-roster fallback is a PLACEHOLDER. It is one user's own boards,
//     never the gym's roster, so it may paint but must never be cached as the
//     server's answer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { GET_GYM_BOARDS_FOR_SWITCHER } from '@boardsesh/graphql/operations/gyms';
import type { GetMyBoardsQueryResponse } from '../../operations';
import { gymBoardsQueryKey, GYM_BOARDS_QUERY_KEY, myBoardsQueryKey } from '../../query-keys';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { useGymBoards } from '../use-gym-boards';

const GYM_UUID = 'gym-1111-2222-3333';

function makeBoard(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    slug: 'kilter-main',
    ownerId: 'user-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: 'Main wall',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    hasLeds: true,
    createdAt: '2026-01-04T09:00:00.000Z',
    totalAscents: 12,
    uniqueClimbers: 3,
    followerCount: 2,
    commentCount: 0,
    isFollowedByMe: true,
    gymUuid: GYM_UUID,
    gymName: 'Klimmuur Centraal',
    canEdit: false,
    isPinnedByMe: false,
    ...overrides,
  };
}

function seedRoster(queryClient: QueryClient, boards: UserBoard[]) {
  const roster: GetMyBoardsQueryResponse = {
    myBoards: { boards, totalCount: boards.length, hasMore: false },
  };
  queryClient.setQueryData(myBoardsQueryKey(), roster);
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

/** A request the test never releases, so the placeholder is what renders. */
function pendingRequest() {
  requestMock.mockImplementation(() => new Promise(() => {}));
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useGymBoards', () => {
  it('stays disabled until a gym uuid resolves', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useGymBoards(null), { wrapper: Wrapper });

    await Promise.resolve();
    expect(requestMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('asks for the switcher document, keyed per gym under the shared root', async () => {
    requestMock.mockResolvedValue({ gymBoards: [makeBoard({ uuid: 'board-a' })] });

    const { queryClient, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useGymBoards(GYM_UUID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(requestMock).toHaveBeenCalledWith(GET_GYM_BOARDS_FOR_SWITCHER, { gymUuid: GYM_UUID });
    expect(gymBoardsQueryKey(GYM_UUID)).toEqual(['gymBoards', GYM_UUID]);
    expect(queryClient.getQueryData(gymBoardsQueryKey(GYM_UUID))).toEqual({
      gymBoards: [makeBoard({ uuid: 'board-a' })],
    });
  });

  it("is reached by the link mutation's root invalidation", async () => {
    requestMock.mockResolvedValue({ gymBoards: [makeBoard({})] });

    const { queryClient, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useGymBoards(GYM_UUID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    // The mutation drops every gym's list by the root alone, so the proof the
    // keys still line up is that this entry refetches.
    await queryClient.invalidateQueries({ queryKey: GYM_BOARDS_QUERY_KEY });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
  });

  it('paints the cached roster while the request is in flight', async () => {
    pendingRequest();
    const { queryClient, Wrapper } = makeWrapper();
    seedRoster(queryClient, [
      makeBoard({ uuid: 'board-here', name: 'Kilter at the gym' }),
      makeBoard({ uuid: 'board-elsewhere', name: 'Home wall', gymUuid: 'another-gym', gymName: null }),
    ]);

    const { result } = renderHook(() => useGymBoards(GYM_UUID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]?.uuid).toBe('board-here');
    expect(result.current.isPlaceholderData).toBe(true);
  });

  it('never stores the placeholder as if the server had answered', async () => {
    pendingRequest();
    const { queryClient, Wrapper } = makeWrapper();
    seedRoster(queryClient, [makeBoard({ uuid: 'board-here' })]);

    const { result } = renderHook(() => useGymBoards(GYM_UUID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(queryClient.getQueryData(gymBoardsQueryKey(GYM_UUID))).toBeUndefined();
  });

  it('shows no rows rather than an empty gym when the roster has none there', async () => {
    pendingRequest();
    const { queryClient, Wrapper } = makeWrapper();
    seedRoster(queryClient, [makeBoard({ uuid: 'board-elsewhere', gymUuid: 'another-gym' })]);

    const { result } = renderHook(() => useGymBoards(GYM_UUID), { wrapper: Wrapper });

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
  });

  it("replaces the placeholder with the gym's own boards once they land", async () => {
    requestMock.mockResolvedValue({
      gymBoards: [makeBoard({ uuid: 'board-here' }), makeBoard({ uuid: 'board-not-mine', ownerId: 'user-2' })],
    });
    const { queryClient, Wrapper } = makeWrapper();
    seedRoster(queryClient, [makeBoard({ uuid: 'board-here' })]);

    const { result } = renderHook(() => useGymBoards(GYM_UUID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.isPlaceholderData).toBe(false);
  });
});
