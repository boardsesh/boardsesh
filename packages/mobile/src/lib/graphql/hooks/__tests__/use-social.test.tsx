// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
  type QueryFunctionContext,
  type QueryKey,
} from '@tanstack/react-query';
import {
  FOLLOW_USER,
  GET_BULK_VOTE_SUMMARIES,
  GET_FOLLOWERS,
  SEARCH_USERS,
  UNFOLLOW_USER,
} from '@boardsesh/graphql/operations';
import type { FollowConnection, UserSearchConnection, VoteSummary } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());
const requestSignals = vi.hoisted(() => [] as AbortSignal[]);
vi.mock('../../../local-user-id', () => ({ readLocalUserId: async () => 'me' }));
vi.mock('../../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'me', isLoading: false }),
}));
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => null }));

vi.mock('../../client', () => ({
  getHttpClient: () => ({
    request: (document: unknown, variables?: unknown) => {
      if (document !== null && typeof document === 'object' && 'document' in document) {
        const options = document as { document: unknown; variables?: unknown; signal: AbortSignal };
        requestSignals.push(options.signal);
        return requestMock(options.document, options.variables);
      }
      return requestMock(document, variables);
    },
  }),
  getOfflineSyncHttpClient: vi.fn(),
}));

import { useBulkVoteSummaries, useFollowers, useSearchUsers, useToggleUserFollow } from '../use-social';
import { getHttpClient } from '../../client';
import { useHttpInfiniteQuery } from '../../use-http-query';

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
  requestSignals.length = 0;
});

describe('useFollowers', () => {
  it('cancels its original native request on unmount and never publishes its late rows', async () => {
    let complete!: (response: { followers: FollowConnection }) => void;
    requestMock.mockImplementation(
      () => new Promise<{ followers: FollowConnection }>((resolve) => (complete = resolve)),
    );
    const { queryClient, Wrapper } = makeWrapper();
    const { unmount } = renderHook(() => useFollowers('profile-user'), { wrapper: Wrapper });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(requestSignals[0].aborted).toBe(false);
    expect(queryClient.getQueryCache().getAll()[0].queryKey).toEqual(['followers', 'profile-user']);

    unmount();
    expect(requestSignals[0].aborted).toBe(true);
    await act(async () => {
      complete({ followers: makeFollowConnection(0) });
    });
    expect(queryClient.getQueryData(['followers', 'profile-user'])).toBeUndefined();
    queryClient.clear();
  });

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

describe('opt-in original native infinite query executor', () => {
  type NativePage = { followers: FollowConnection };
  type NativeContext = QueryFunctionContext<QueryKey, number>;

  it.each([false, true] as const)(
    'keeps the actual context unread and completes held first/next raw pages after unmount (pageDelivery=%s)',
    async (pageDelivery) => {
      const { queryClient, Wrapper } = makeWrapper();
      const key = ['native-original-infinite', pageDelivery] as const;
      const observations: { context: object; signalReads: number }[] = [];
      const nativeContexts: NativeContext[] = [];
      const defineProperty = Object.defineProperty;
      // A persister is unsuitable here: installed infiniteQueryBehavior reads
      // context.signal before calling it. Observe only the real page-context
      // getter at its creation, preserving its object, getter, and flags.
      function observeProperty<T>(target: T, property: PropertyKey, descriptor: PropertyDescriptor): T {
        if (
          property === 'signal' &&
          descriptor.get &&
          target !== null &&
          typeof target === 'object' &&
          'client' in target &&
          target.client === queryClient &&
          'queryKey' in target &&
          target.queryKey === key &&
          'pageParam' in target &&
          'direction' in target &&
          target.direction === 'forward'
        ) {
          const observation = { context: target, signalReads: 0 };
          observations.push(observation);
          return defineProperty(target, property, {
            ...descriptor,
            get() {
              observation.signalReads += 1;
              return descriptor.get!.call(this);
            },
          });
        }
        return defineProperty(target, property, descriptor);
      }
      const propertySpy = vi.spyOn(Object, 'defineProperty').mockImplementation(observeProperty);
      let firstComplete!: (response: NativePage) => void;
      let nextComplete!: (response: NativePage) => void;
      const first = new Promise<NativePage>((resolve) => {
        firstComplete = resolve;
      });
      const next = new Promise<NativePage>((resolve) => {
        nextComplete = resolve;
      });
      requestMock.mockReturnValueOnce(first).mockReturnValueOnce(next);
      const firstResponse = { followers: makeFollowConnection(0) };
      const nextResponse = { followers: makeFollowConnection(30) };
      const options = {
        queryKey: key,
        initialPageParam: 0,
        staleTime: Infinity,
        queryFn: async () => {
          throw new Error('Native opt-in reached the default HTTP operation executor');
        },
        nativeQueryFn: (context: NativeContext) => {
          nativeContexts.push(context);
          return getHttpClient().request<NativePage>(GET_FOLLOWERS, {
            input: { userId: 'native-target', offset: context.pageParam, limit: 30 },
          });
        },
        getNextPageParam: (lastPage: NativePage, pages: NativePage[]) =>
          lastPage.followers.hasMore
            ? pages.reduce((count, page) => count + page.followers.users.length, 0)
            : undefined,
      };
      const useNative = pageDelivery
        ? function useWithPageSource() {
            return useHttpInfiniteQuery<NativePage, Error, QueryKey, number>({ ...options, pageDelivery: true });
          }
        : function useWithoutPageSource() {
            return useHttpInfiniteQuery<NativePage, Error, InfiniteData<NativePage, number>, QueryKey, number>({
              ...options,
              pageDelivery: false,
            });
          };
      let view = renderHook(useNative, { wrapper: Wrapper });
      try {
        await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
        expect(observations).toHaveLength(1);
        expect(nativeContexts[0]).toBe(observations[0].context);
        expect(nativeContexts[0].client).toBe(queryClient);
        expect(nativeContexts[0].queryKey).toBe(key);
        expect(nativeContexts[0].pageParam).toBe(0);
        expect(observations[0].signalReads).toBe(0);
        const firstQuery = queryClient.getQueryCache().find({ queryKey: key, exact: true });
        const firstSettled = firstQuery!.promise!.then(
          () => 'resolved',
          () => 'rejected',
        );
        view.unmount();
        expect(observations[0].signalReads).toBe(0);
        await act(async () => {
          firstComplete(firstResponse);
          await firstSettled;
        });
        expect(await firstSettled).toBe('resolved');
        expect(queryClient.getQueryData(key)).toEqual({ pages: [firstResponse], pageParams: [0] });
        view = renderHook(useNative, { wrapper: Wrapper });
        await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
        expect(requestMock).toHaveBeenCalledTimes(1);
        let nextSettled!: Promise<string>;
        act(() => {
          nextSettled = view.result.current.fetchNextPage().then((result) => result.status);
        });
        await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
        expect(observations).toHaveLength(2);
        expect(nativeContexts[1]).toBe(observations[1].context);
        expect(nativeContexts[1].pageParam).toBe(30);
        view.unmount();
        expect(observations.map((observation) => observation.signalReads)).toEqual([0, 0]);
        await act(async () => {
          nextComplete(nextResponse);
          await nextSettled;
        });
        expect(await nextSettled).toBe('success');
        expect(queryClient.getQueryData(key)).toEqual({
          pages: [firstResponse, nextResponse],
          pageParams: [0, 30],
        });
        expect(observations.map((observation) => observation.signalReads)).toEqual([0, 0]);
        expect(requestSignals).toEqual([]);
        expect(requestMock.mock.calls).toEqual([
          [GET_FOLLOWERS, { input: { userId: 'native-target', offset: 0, limit: 30 } }],
          [GET_FOLLOWERS, { input: { userId: 'native-target', offset: 30, limit: 30 } }],
        ]);
      } finally {
        firstComplete(firstResponse);
        nextComplete(nextResponse);
        view.unmount();
        queryClient.clear();
        propertySpy.mockRestore();
      }
    },
  );
});
