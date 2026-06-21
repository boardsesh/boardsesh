// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FOLLOW_USER, GET_FOLLOWERS, SEARCH_USERS, UNFOLLOW_USER } from '@boardsesh/graphql/operations';
import type { FollowConnection, UserSearchConnection } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

import { useFollowers, useSearchUsers, useToggleUserFollow } from '../use-social';

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
