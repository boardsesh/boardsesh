// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_PUBLIC_PROFILE } from '@boardsesh/graphql/operations';
import type { HttpQueryScope } from '../http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing captured social view');
    return selected.scope;
  },
}));
// These writers are deliberately outside this read-only tranche. A read must
// use the real fixture's scoped SDK rather than fall back to the raw client.
vi.mock('../client', () => ({
  getHttpClient: () => {
    throw new Error('Social reader used an uncaptured client');
  },
}));
vi.mock('../hooks/use-followed-authors', () => ({ useToggleAuthorFollow: vi.fn() }));

import { createScopedHttpFixture } from './fixtures/scoped-http';
import {
  useBulkVoteSummaries,
  useComments,
  useFollowers,
  useFollowing,
  usePublicProfile,
  useSearchUsers,
} from '../hooks/use-social';

const targetUserId = 'another-public-climber';
const entityIds = ['tick-one', 'tick-two'];
const closeFixtures: (() => void)[] = [];

beforeEach(() => vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0'));
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
  vi.unstubAllEnvs();
});

function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper };
}

type RequestBody = {
  query: string;
  variables?: {
    userId?: string;
    input?: { userId?: string; query?: string; offset?: number; limit?: number; entityIds?: string[] };
  };
};
function requestBody(init: unknown): RequestBody {
  return JSON.parse((init as RequestInit).body as string) as RequestBody;
}
function person(score: number) {
  return {
    id: targetUserId,
    displayName: `reader-${score}`,
    followerCount: score,
    followingCount: score,
    isFollowedByMe: score === 1,
  };
}
function payload(request: RequestBody, score: number, more = false) {
  if (request.query.includes('publicProfile('))
    return { publicProfile: { ...person(score), isPrivate: true, canViewActivity: true, instagramUrl: null } };
  const users = more
    ? Array.from({ length: 30 }, (_, index) => ({ ...person(score), id: `person-${index}` }))
    : [person(score)];
  const connection = { users, totalCount: more ? 60 : 1, hasMore: more && request.variables?.input?.offset === 0 };
  if (request.query.includes('followers(')) return { followers: connection };
  if (request.query.includes('following(')) return { following: connection };
  if (request.query.includes('searchUsers('))
    return {
      searchUsers: {
        results: users.map((user) => ({ user, recentAscentCount: score, matchReason: 'name match' })),
        totalCount: connection.totalCount,
        hasMore: connection.hasMore,
      },
    };
  if (request.query.includes('bulkVoteSummaries('))
    return {
      bulkVoteSummaries: (request.variables?.input?.entityIds ?? []).map((entityId) => ({
        entityType: 'tick',
        entityId,
        upvotes: score,
        downvotes: 0,
        voteScore: score,
        userVote: score === 1 ? 1 : 0,
      })),
    };
  if (request.query.includes('comments('))
    return {
      comments: {
        comments: [
          {
            uuid: 'comment-one',
            userId: targetUserId,
            body: `reader-${score}`,
            entityType: 'playlist_climb',
            entityId: 'public-playlist:_all',
            isDeleted: false,
            replyCount: 0,
            upvotes: score,
            downvotes: 0,
            voteScore: score,
            userVote: score === 1 ? 1 : 0,
            createdAt: '2026-11-15T00:00:00.000Z',
            updatedAt: '2026-11-15T00:00:00.000Z',
          },
        ],
        totalCount: 1,
        hasMore: false,
      },
    };
  throw new Error('Unexpected social read document');
}
function useReadSet(enabled = true) {
  return {
    profile: usePublicProfile(targetUserId, enabled),
    followers: useFollowers(targetUserId, enabled),
    following: useFollowing(targetUserId, enabled),
    search: useSearchUsers('  ma  ', enabled),
    votes: useBulkVoteSummaries('tick', entityIds, enabled),
    comments: useComments('playlist_climb', 'public-playlist:_all', enabled),
  };
}
function expectReadSet(readers: ReturnType<typeof useReadSet>, score: number) {
  expect(readers.profile.data?.displayName).toBe(`reader-${score}`);
  expect(readers.followers.data?.pages[0].users[0].displayName).toBe(`reader-${score}`);
  expect(readers.following.data?.pages[0].users[0].displayName).toBe(`reader-${score}`);
  expect(readers.search.data?.pages[0].results[0].user.displayName).toBe(`reader-${score}`);
  expect(readers.votes.data[0]?.voteScore).toBe(score);
  expect(readers.comments.data?.comments[0].body).toBe(`reader-${score}`);
}
function heldResponse(responsePayload: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: responsePayload })));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}

describe('actual SDK captured social readers', () => {
  it('publishes all six signed-in reads only in the selected cache, preserving another climber target', async () => {
    const current = fixture();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 1) }),
    );
    const { result } = renderHook(useReadSet, current);
    await waitFor(() => expectReadSet(result.current, 1));
    expect(current.performFetch).toHaveBeenCalledTimes(6);
    expect(
      current.cache
        .getQueryCache()
        .getAll()
        .every((query) => selected.scope!.ownsKey(query.queryKey)),
    ).toBe(true);
    expect(current.cache.getQueryData(['publicProfile', targetUserId])).toBeUndefined();
    for (const [, init] of current.performFetch.mock.calls) {
      const body = requestBody(init);
      if (body.query.includes('publicProfile(')) expect(body.variables?.userId).toBe(targetUserId);
      if (body.query.includes('followers(') || body.query.includes('following('))
        expect(body.variables?.input?.userId).toBe(targetUserId);
      if (body.query.includes('searchUsers(')) expect(body.variables?.input?.query).toBe('ma');
    }
  });

  it('keeps confirmed-anonymous public reads available without a lease or bearer', async () => {
    const current = fixture();
    current.confirmAnonymous();
    selected.scope = current.scope();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 2) }),
    );
    const { result } = renderHook(useReadSet, current);
    await waitFor(() => expectReadSet(result.current, 2));
    expect(current.performFetch).toHaveBeenCalledTimes(6);
    expect(current.issueLease).not.toHaveBeenCalled();
    for (const [, init] of current.performFetch.mock.calls)
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBeNull();
  });

  it('does not display a previous viewer cached audience or vote state while the new view loads', async () => {
    const current = fixture();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 1) }),
    );
    const { result, rerender } = renderHook(useReadSet, current);
    await waitFor(() => expectReadSet(result.current, 1));
    current.switchAccount('owned-B');
    selected.scope = current.scope();
    const held: ReturnType<typeof heldResponse>[] = [];
    current.performFetch.mockImplementation(async (_url, init) => {
      const body = heldResponse(payload(requestBody(init), 2));
      held.push(body);
      return body.response;
    });
    rerender();
    expect(result.current.profile.data).toBeUndefined();
    expect(result.current.followers.data).toBeUndefined();
    expect(result.current.following.data).toBeUndefined();
    expect(result.current.search.data).toBeUndefined();
    expect(result.current.votes.data).toEqual([]);
    expect(result.current.comments.data).toBeUndefined();
    await waitFor(() => expect(held).toHaveLength(6));
    await act(async () => held.forEach((body) => body.release()));
    await waitFor(() => expectReadSet(result.current, 2));
  });

  it('keeps unavailable original views and disabled readers inert', async () => {
    const current = fixture();
    selected.scope = Object.freeze({ ...selected.scope!, isReady: () => false });
    const { result, rerender } = renderHook(({ enabled }) => useReadSet(enabled), {
      ...current,
      initialProps: { enabled: true },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(result.current.profile.fetchStatus).toBe('idle');
    selected.scope = current.scope();
    rerender({ enabled: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('does not send GraphQL when actual central lease admission fails', async () => {
    const current = fixture();
    current.issueLease.mockResolvedValue(Response.json({ status: 'unavailable' }, { status: 503 }));
    const { result } = renderHook(useReadSet, current);
    await waitFor(() => expect(result.current.profile.isError).toBe(true));
    expect(current.issueLease).toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
    expect(
      current.cache
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });

  it.each(['B', 'ABA', 'same-owner-generation'] as const)(
    'refuses all six delayed bodies across %s',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      const held: ReturnType<typeof heldResponse>[] = [];
      current.performFetch.mockImplementation(async (_url, init) => {
        const body = heldResponse(payload(requestBody(init), 1));
        held.push(body);
        return body.response;
      });
      const { result, rerender } = renderHook(useReadSet, current);
      await waitFor(() => expect(held).toHaveLength(6));
      if (change === 'same-owner-generation') current.nextGeneration();
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      selected.scope = current.scope();
      current.performFetch.mockImplementation(async (_url, init) =>
        Response.json({ data: payload(requestBody(init), 2) }),
      );
      rerender();
      await waitFor(() => expectReadSet(result.current, 2));
      await act(async () => held.forEach((body) => body.release()));
      expectReadSet(result.current, 2);
      const oldQueries = current.cache
        .getQueryCache()
        .getAll()
        .filter((query) => original.ownsKey(query.queryKey));
      expect(oldQueries).toHaveLength(6);
      expect(oldQueries.every((query) => query.state.data === undefined)).toBe(true);
    },
  );

  it('cannot extend old body receipts with a freshly admitted same-owner lease', async () => {
    const current = fixture();
    const held: ReturnType<typeof heldResponse>[] = [];
    current.performFetch.mockImplementation(async (_url, init) => {
      const body = heldResponse(payload(requestBody(init), 1));
      held.push(body);
      return body.response;
    });
    const { result } = renderHook(useReadSet, current);
    await waitFor(() => expect(held).toHaveLength(6));
    current.clock(120_001);
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 2) }),
    );
    const fresh = current.scope().create();
    await fresh.request(GET_PUBLIC_PROFILE, { userId: targetUserId });
    fresh.assertDeliveries();
    expect(current.issueLease).toHaveBeenCalledTimes(2);
    await act(async () => held.forEach((body) => body.release()));
    await waitFor(() => expect(result.current.profile.isError).toBe(true));
    await waitFor(() => expect(result.current.comments.isError).toBe(true));
    expect(
      current.cache
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });

  it('rechecks the original delivery after a completed SDK result waits before cache publication', async () => {
    const current = fixture();
    const original = selected.scope!;
    const releases: (() => void)[] = [];
    closeFixtures.push(() => releases.forEach((release) => release()));
    selected.scope = Object.freeze({
      ...original,
      create(options) {
        const operation = original.create(options);
        return Object.freeze({
          ...operation,
          request: new Proxy(operation.request, {
            async apply(target, receiver, parameters: unknown[]) {
              // Retain the actual decoded SDK object and admitted receipt;
              // only caller-side continuation timing is injected.
              const result: unknown = await Reflect.apply(target, receiver, parameters);
              await new Promise<void>((resolve) => releases.push(resolve));
              return result;
            },
          }),
        });
      },
    });
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 1) }),
    );
    const { result } = renderHook(useReadSet, current);
    await waitFor(() => expect(releases).toHaveLength(6));
    current.clock(120_001);
    const fresh = current.scope().create();
    await fresh.request(GET_PUBLIC_PROFILE, { userId: targetUserId });
    fresh.assertDeliveries();
    expect(current.issueLease).toHaveBeenCalledTimes(2);
    await act(async () => releases.forEach((release) => release()));
    await waitFor(() => expect(result.current.profile.isError).toBe(true));
    await waitFor(() => expect(result.current.comments.isError).toBe(true));
    expect(result.current.votes.data).toEqual([]);
    expect(
      current.cache
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });

  it.each(['B', 'ABA'] as const)('does not let retired refetch/page/chunk handles borrow %s', async (change) => {
    const current = fixture();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 1) }),
    );
    const { result, unmount } = renderHook(useReadSet, current);
    await waitFor(() => expectReadSet(result.current, 1));
    const original = result.current;
    unmount();
    current.switchAccount('owned-B');
    if (change === 'ABA') current.switchAccount('owned-A');
    selected.scope = current.scope();
    await act(async () => {
      await Promise.all([
        original.profile.refetch(),
        original.followers.fetchNextPage(),
        original.following.refetch(),
        original.search.fetchNextPage(),
        original.votes.refetch(),
        original.comments.refetch(),
      ]);
    });
    expect(current.performFetch).toHaveBeenCalledTimes(6);
  });

  it('gives each people page its own request and preserves offset/limit/screenshot rules', async () => {
    const current = fixture();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 1, true) }),
    );
    const { result } = renderHook(
      () => ({
        followers: useFollowers(targetUserId),
        following: useFollowing(targetUserId),
        search: useSearchUsers('  ma  '),
      }),
      current,
    );
    await waitFor(() => {
      for (const reader of Object.values(result.current)) expect(reader.hasNextPage).toBe(true);
    });
    await act(async () => {
      await Promise.all([
        result.current.followers.fetchNextPage(),
        result.current.following.fetchNextPage(),
        result.current.search.fetchNextPage(),
      ]);
    });
    await waitFor(() => {
      for (const reader of Object.values(result.current)) expect(reader.data?.pages).toHaveLength(2);
    });
    for (const document of ['followers(', 'following(', 'searchUsers(']) {
      const requests = current.performFetch.mock.calls
        .map(([, init]) => requestBody(init))
        .filter((body) => body.query.includes(document));
      expect(requests.map((body) => body.variables?.input?.offset)).toEqual([0, 30]);
      expect(requests.every((body) => body.variables?.input?.limit === 30)).toBe(true);
    }
  });

  it('retains the one-page screenshot cap for all three people readers', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const current = fixture();
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({ data: payload(requestBody(init), 1, true) }),
    );
    const { result } = renderHook(
      () => ({
        followers: useFollowers(targetUserId),
        following: useFollowing(targetUserId),
        search: useSearchUsers('ma'),
      }),
      current,
    );
    await waitFor(() => {
      for (const reader of Object.values(result.current)) {
        expect(reader.data?.pages).toHaveLength(1);
        expect(reader.hasNextPage).toBe(false);
      }
    });
    await act(async () => {
      await Promise.all(Object.values(result.current).map((reader) => reader.fetchNextPage()));
    });
    expect(current.performFetch).toHaveBeenCalledTimes(3);
  });

  it('retains independent <=100-ID chunks, good siblings and stable combined identities', async () => {
    const current = fixture();
    const manyIds = Array.from({ length: 135 }, (_, index) => `tick-${index}`);
    let failSecond = true;
    let score = 1;
    current.performFetch.mockImplementation(async (_url, init) => {
      const body = requestBody(init);
      if (failSecond && body.variables?.input?.entityIds?.includes('tick-100'))
        return Response.json({ errors: [{ message: 'Second chunk refused' }] });
      return Response.json({ data: payload(body, score) });
    });
    const { result, rerender } = renderHook(() => useBulkVoteSummaries('tick', [...manyIds]), current);
    await waitFor(() => expect(result.current.data).toHaveLength(100));
    const settled = result.current;
    rerender();
    expect(result.current).toBe(settled);
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    const requests = current.performFetch.mock.calls.map(([, init]) => requestBody(init));
    expect(requests.map((body) => body.variables?.input?.entityIds?.length)).toEqual([100, 35]);
    expect(requests[0].variables?.input?.entityIds).toEqual(manyIds.slice(0, 100));
    failSecond = false;
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toHaveLength(135));
    failSecond = true;
    score = 2;
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data[0].voteScore).toBe(2));
    expect(result.current.data).toHaveLength(135);
    expect(result.current.data[0].entityId).toBe('tick-0');
    expect(result.current.data[100].voteScore).toBe(1);
  });

  it('does not ask for empty chunks or search text below two trimmed characters', async () => {
    const current = fixture();
    const { result, rerender } = renderHook(
      () => ({ votes: useBulkVoteSummaries('tick', []), search: useSearchUsers(' a ') }),
      current,
    );
    const empty = result.current.votes;
    rerender();
    expect(result.current.votes).toBe(empty);
    await act(async () => {
      await Promise.resolve();
    });
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('forwards cancellation to every actual request and refuses its late decoded body', async () => {
    const current = fixture();
    const held: ReturnType<typeof heldResponse>[] = [];
    current.performFetch.mockImplementation(async (_url, init) => {
      const body = heldResponse(payload(requestBody(init), 1));
      held.push(body);
      return body.response;
    });
    const { unmount } = renderHook(useReadSet, current);
    await waitFor(() => expect(held).toHaveLength(6));
    const signals = current.performFetch.mock.calls.map(([, init]) => (init as RequestInit).signal!);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => held.forEach((body) => body.release()));
    expect(
      current.cache
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });
});
