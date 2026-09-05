// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  FOLLOW_USER,
  GET_BULK_VOTE_SUMMARIES,
  GET_FOLLOWERS,
  SEARCH_USERS,
  UNFOLLOW_USER,
} from '@boardsesh/graphql/operations';
import type { FollowConnection, UserSearchConnection, VoteSummary } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { useBulkVoteSummaries, useFollowers, useSearchUsers, useToggleUserFollow } from '../use-social';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

function makeFollowConnection(offset: number): FollowConnection {
  return {
    users: Array.from({ length: 30 }, (_, index) => ({
      id: `user-${offset + index}`,
      displayName: `User ${offset + index}`,
      followerCount: 0,
      followingCount: 0,
      isFollowedByMe: false,
    })),
    totalCount: 90,
    hasMore: offset < 60,
  };
}

function makeVoteSummary(entityId: string): VoteSummary {
  return { entityType: 'tick', entityId, upvotes: 1, downvotes: 0, voteScore: 1, userVote: 0 };
}

function makeSearchConnection(offset: number): UserSearchConnection {
  return {
    results: Array.from({ length: 30 }, (_, index) => ({
      user: {
        id: `result-${offset + index}`,
        displayName: `Result ${offset + index}`,
        followerCount: 0,
        followingCount: 0,
        isFollowedByMe: false,
      },
      recentAscentCount: 0,
      matchReason: 'display_name',
    })),
    totalCount: 60,
    hasMore: offset < 30,
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useFollowers', () => {
  it('advances offset pagination by the accumulated user count', async () => {
    requestMock.mockImplementation((_query: unknown, variables: { input: { offset: number } }) =>
      Promise.resolve({ followers: makeFollowConnection(variables.input.offset) }),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useFollowers('profile-user'), { wrapper: Wrapper });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(requestMock).toHaveBeenLastCalledWith(GET_FOLLOWERS, {
      input: { userId: 'profile-user', limit: 30, offset: 0 },
    });

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(requestMock).toHaveBeenLastCalledWith(GET_FOLLOWERS, {
      input: { userId: 'profile-user', limit: 30, offset: 30 },
    });

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(3));
    expect(requestMock).toHaveBeenLastCalledWith(GET_FOLLOWERS, {
      input: { userId: 'profile-user', limit: 30, offset: 60 },
    });
  });
});

describe('useSearchUsers', () => {
  it('does not request for queries shorter than two characters', async () => {
    const { Wrapper } = makeWrapper();

    renderHook(() => useSearchUsers('m'), { wrapper: Wrapper });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('trims queries and paginates search requests by result count', async () => {
    requestMock.mockImplementation((_query: unknown, variables: { input: { offset: number } }) =>
      Promise.resolve({ searchUsers: makeSearchConnection(variables.input.offset) }),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useSearchUsers('  ma  '), { wrapper: Wrapper });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(requestMock).toHaveBeenLastCalledWith(SEARCH_USERS, {
      input: { query: 'ma', limit: 30, offset: 0 },
    });

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(requestMock).toHaveBeenLastCalledWith(SEARCH_USERS, {
      input: { query: 'ma', limit: 30, offset: 30 },
    });
  });
});

describe('useToggleUserFollow', () => {
  it('follows users and invalidates affected social queries', async () => {
    requestMock.mockResolvedValue({ followUser: true });
    const { queryClient, Wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useToggleUserFollow('me'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ userId: 'target-user', isFollowedByMe: false });
    });

    expect(requestMock).toHaveBeenCalledWith(FOLLOW_USER, { input: { userId: 'target-user' } });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['publicProfile', 'target-user'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['publicProfile', 'me'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['followers'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['following'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['searchUsers'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activityFeed'] });
  });

  it('unfollows users with the unfollow mutation', async () => {
    requestMock.mockResolvedValue({ unfollowUser: true });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useToggleUserFollow('me'), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ userId: 'target-user', isFollowedByMe: true });
    });

    expect(requestMock).toHaveBeenCalledWith(UNFOLLOW_USER, { input: { userId: 'target-user' } });
  });
});

describe('useBulkVoteSummaries', () => {
  // Regression coverage for #4102: a paginating feed (e.g. SessionsTab) can
  // hand this hook well over 100 entity ids, which the backend's
  // BulkVoteSummaryInputSchema rejects outright (`.max(100)`). The hook must
  // chunk internally so no single request ever exceeds the cap.
  it('splits a list over the backend 100-ID cap into multiple <=100-ID requests and merges the results', async () => {
    const entityIds = Array.from({ length: 135 }, (_, index) => `tick-${String(index).padStart(3, '0')}`);
    requestMock.mockImplementation((_query: unknown, variables: { input: { entityIds: string[] } }) =>
      Promise.resolve({
        bulkVoteSummaries: variables.input.entityIds.map((entityId) => makeVoteSummary(entityId)),
      }),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useBulkVoteSummaries('tick', entityIds), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(135));

    expect(requestMock).toHaveBeenCalledTimes(2);
    for (const [query, variables] of requestMock.mock.calls as [unknown, { input: { entityIds: string[] } }][]) {
      expect(query).toBe(GET_BULK_VOTE_SUMMARIES);
      expect(variables.input.entityIds.length).toBeLessThanOrEqual(100);
    }
    const requestedIds = (requestMock.mock.calls as [unknown, { input: { entityIds: string[] } }][]).flatMap(
      ([, variables]) => variables.input.entityIds,
    );
    expect(new Set(requestedIds).size).toBe(135);
  });

  it("keeps a resolved chunk's rows when a sibling chunk's request fails, instead of blanking everything", async () => {
    const entityIds = Array.from({ length: 135 }, (_, index) => `tick-${String(index).padStart(3, '0')}`);
    requestMock.mockImplementation((_query: unknown, variables: { input: { entityIds: string[] } }) => {
      // The second chunk (ids 100-134) fails; the first chunk (0-99) resolves.
      if (variables.input.entityIds.includes('tick-100')) {
        return Promise.reject(new Error('chunk 2 failed'));
      }
      return Promise.resolve({
        bulkVoteSummaries: variables.input.entityIds.map((entityId) => makeVoteSummary(entityId)),
      });
    });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useBulkVoteSummaries('tick', entityIds), { wrapper: Wrapper });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.data).toHaveLength(100));

    const returnedIds = new Set(result.current.data.map((summary) => summary.entityId));
    expect(returnedIds.has('tick-000')).toBe(true);
    expect(returnedIds.has('tick-099')).toBe(true);
    // The failed chunk's rows are simply absent, not blanking the rows that did load.
    expect(returnedIds.has('tick-100')).toBe(false);
  });

  // The Home feed rebuilds its vote map from `.data` and feeds the result to
  // FlashList as `extraData`, so a `.data` array that changes identity on every
  // parent render re-invokes `renderItem` for every mounted row. `useQueries`
  // only holds identity when it is given a `combine` — see
  // combineVoteSummaryChunks in use-social.ts.
  it('holds the identity of data and refetch across re-renders, so the feed does not re-render every row', async () => {
    const entityIds = Array.from({ length: 135 }, (_, index) => `tick-${String(index).padStart(3, '0')}`);
    requestMock.mockImplementation((_query: unknown, variables: { input: { entityIds: string[] } }) =>
      Promise.resolve({
        bulkVoteSummaries: variables.input.entityIds.map((entityId) => makeVoteSummary(entityId)),
      }),
    );
    const { Wrapper } = makeWrapper();

    // A fresh array each render, the way a caller passing `ids.filter(...)` inline would.
    const { result, rerender } = renderHook(() => useBulkVoteSummaries('tick', [...entityIds]), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(135));
    const settledData = result.current.data;
    const settledResult = result.current;

    rerender();
    rerender();

    expect(result.current.data).toBe(settledData);
    expect(result.current).toBe(settledResult);
  });
});
