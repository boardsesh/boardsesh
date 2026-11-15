// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoteSummary } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../http-query-scope';
import { GraphQLClient } from 'graphql-request';

const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  nativeClient: null as GraphQLClient | null,
}));
vi.mock('../../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing social mutation view');
    return selected.scope;
  },
}));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    if (selected.nativeClient) return selected.nativeClient;
    throw new Error('Social mutation used an uncaptured client');
  },
}));
vi.mock('../use-followed-authors', () => ({ useToggleAuthorFollow: vi.fn() }));
vi.mock('../index', async () => {
  const social = await vi.importActual<typeof import('../use-social')>('../use-social');
  return { useVote: social.useVote };
});

import { createScopedHttpFixture } from '../../__tests__/fixtures/scoped-http';
import { createHttpQueryScope } from '../../http-query-scope';
import { createHttpOperation } from '../../http-operation';
import { useAddComment, useVote } from '../use-social';
import { useOptimisticVote } from '../../../../components/you/use-optimistic-vote';

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((dispose) => dispose());
  selected.scope = null;
  selected.nativeClient = null;
});
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  disposals.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper };
}
function summary(upvotes: number): VoteSummary {
  return { entityType: 'tick', entityId: 'tick-one', upvotes, downvotes: 0, voteScore: upvotes, userVote: 1 };
}
const voteInput = { entityType: 'tick' as const, entityId: 'tick-one', value: 1 as const };
const commentInput = { entityType: 'tick' as const, entityId: 'tick-one', body: 'nice send' };
const comment = { uuid: 'comment-one', ...commentInput, userId: 'owned-A' };
function useWriters() {
  return { vote: useVote(), comment: useAddComment() };
}
function heldResponse() {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ data: { vote: summary(9), addComment: comment } })),
        );
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function renew(current: ReturnType<typeof fixture>) {
  current.clock(120_001);
  const owner = current.backend.getSnapshot().owner;
  if (!owner) throw new Error('Expected the same selected owner');
  const lease = await current.backend.acquire(owner);
  const scope = current.backend.capture(lease.token);
  if (!scope) throw new Error('Fresh same-owner lease did not produce a scope');
  current.backend.assertCurrent(scope, lease);
  expect(current.issueLease).toHaveBeenCalledTimes(2);
}

describe('actual SDK social mutation delivery and cache effects', () => {
  it('preserves native vote counts and unprefixed comment/feed keys with the installed SDK', async () => {
    const current = fixture();
    selected.nativeClient = new GraphQLClient('https://native.owned.test/graphql', {
      fetch: async () => Response.json({ data: { vote: summary(9), addComment: comment } }),
    });
    selected.scope = createHttpQueryScope({
      scope: undefined,
      scoped: false,
      prefix: [],
      isCurrentView: () => true,
      createOperation: (options) => createHttpOperation(undefined, options),
    });
    const votes = ['bulkVoteSummaries', 'tick', ['tick-one']];
    const comments = ['comments', 'tick', 'tick-one'];
    current.cache.setQueryData(votes, [summary(1)]);
    for (const key of [comments, ['activityFeed'], ['sessionGroupedFeed']]) current.cache.setQueryData(key, 'before');
    const { result } = renderHook(useWriters, current);
    await act(async () => {
      const vote = await result.current.vote.mutateWithReceipt(voteInput);
      const posted = await result.current.comment.mutateWithReceipt(commentInput);
      vote.assertCurrent();
      posted.assertCurrent();
      vote.dispose();
      posted.dispose();
    });
    expect(current.cache.getQueryData(votes)).toEqual([summary(9)]);
    for (const key of [comments, ['activityFeed'], ['sessionGroupedFeed']])
      expect(current.cache.getQueryState(key)?.isInvalidated).toBe(true);
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it('patches only the original selected vote namespace without copying raw or other-view entries', async () => {
    const current = fixture();
    current.switchAccount('owned-B');
    const other = current.scope();
    current.switchAccount('owned-A');
    const original = current.scope();
    selected.scope = original;
    const rawKey = ['bulkVoteSummaries', 'tick', ['tick-one']];
    for (const key of [rawKey, original.key(rawKey), other.key(rawKey)]) current.cache.setQueryData(key, [summary(1)]);
    current.performFetch.mockResolvedValue(Response.json({ data: { vote: summary(9) } }));
    const { result } = renderHook(useWriters, current);
    await act(async () => {
      const receipt = await result.current.vote.mutateWithReceipt(voteInput);
      receipt.assertCurrent();
      receipt.dispose();
    });
    expect(current.cache.getQueryData(original.key(rawKey))).toEqual([summary(9)]);
    expect(current.cache.getQueryData(other.key(rawKey))).toEqual([summary(1)]);
    expect(current.cache.getQueryData(rawKey)).toEqual([summary(1)]);
    expect(current.performFetch).toHaveBeenCalledOnce();
  });

  it('invalidates the original comment thread and feed prefixes, preserving raw and other-view caches', async () => {
    const current = fixture();
    current.switchAccount('owned-B');
    const other = current.scope();
    current.switchAccount('owned-A');
    const original = current.scope();
    selected.scope = original;
    const keys = [['comments', 'tick', 'tick-one'], ['activityFeed'], ['sessionGroupedFeed']];
    for (const key of keys)
      for (const actual of [key, original.key(key), other.key(key)]) current.cache.setQueryData(actual, 'before');
    current.performFetch.mockResolvedValue(Response.json({ data: { addComment: comment } }));
    const { result } = renderHook(useWriters, current);
    await act(async () => {
      const receipt = await result.current.comment.mutateWithReceipt(commentInput);
      receipt.assertCurrent();
      receipt.dispose();
    });
    for (const key of keys) {
      expect(current.cache.getQueryState(original.key(key))?.isInvalidated).toBe(true);
      expect(current.cache.getQueryState(other.key(key))?.isInvalidated).toBe(false);
      expect(current.cache.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });

  for (const writer of ['vote', 'comment'] as const)
    it.each(['B', 'ABA', 'original-expiry-with-fresh-lease'] as const)(
      `holds ${writer} publication after a real response body waits across %s`,
      async (change) => {
        const current = fixture();
        const original = selected.scope!;
        const key = original.key(['bulkVoteSummaries', 'tick', ['tick-one']]);
        current.cache.setQueryData(key, [summary(1)]);
        const setQueries = vi.spyOn(current.cache, 'setQueriesData');
        const invalidate = vi.spyOn(current.cache, 'invalidateQueries');
        const held = heldResponse();
        current.performFetch.mockResolvedValue(held.response);
        const delivered = vi.fn();
        const { result, rerender } = renderHook(useWriters, current);
        const pending =
          writer === 'vote'
            ? result.current.vote.mutateWithReceipt(voteInput).then(delivered, () => {})
            : result.current.comment.mutateWithReceipt(commentInput).then(delivered, () => {});
        await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
        if (change === 'original-expiry-with-fresh-lease') await renew(current);
        else {
          current.switchAccount('owned-B');
          if (change === 'ABA') current.switchAccount('owned-A');
          selected.scope = current.scope();
          rerender();
        }
        await act(async () => {
          held.release();
          await pending;
        });
        expect(delivered).not.toHaveBeenCalled();
        expect(setQueries).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
        expect(current.cache.getQueryData(key)).toEqual([summary(1)]);
        expect(current.performFetch).toHaveBeenCalledOnce();
      },
    );

  it.each(['B', 'ABA', 'original-expiry-with-fresh-lease'] as const)(
    'checks the original comment delivery after its first awaited cache invalidation crosses %s',
    async (change) => {
      const current = fixture();
      current.performFetch.mockResolvedValue(Response.json({ data: { addComment: comment } }));
      const hold = deferred();
      const invalidate = vi.spyOn(current.cache, 'invalidateQueries').mockImplementationOnce(() => hold.promise);
      const delivered = vi.fn();
      const { result } = renderHook(useWriters, current);
      const pending = result.current.comment.mutateWithReceipt(commentInput).then(delivered, () => {});
      await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
      if (change === 'original-expiry-with-fresh-lease') await renew(current);
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
      }
      await act(async () => {
        hold.resolve();
        await pending;
      });
      expect(invalidate).toHaveBeenCalledOnce();
      expect(delivered).not.toHaveBeenCalled();
      expect(current.performFetch).toHaveBeenCalledOnce();
    },
  );

  it('preserves an ordinary current-view error and explicit cancellation without success publication', async () => {
    const current = fixture();
    current.performFetch.mockResolvedValue(Response.json({ errors: [{ message: 'Comment rejected' }] }));
    const { result } = renderHook(useWriters, current);
    await act(async () => {
      await expect(result.current.comment.mutateWithReceipt(commentInput)).rejects.toThrow('Comment rejected');
    });
    const controller = new AbortController();
    controller.abort();
    await act(async () => {
      await expect(result.current.vote.mutateWithReceipt(voteInput, { signal: controller.signal })).rejects.toThrow();
    });
    expect(current.performFetch).toHaveBeenCalledOnce();
  });

  it.each(['B', 'ABA', 'original-expiry-with-fresh-lease'] as const)(
    'keeps a held actual vote response out of the optimistic row after %s',
    async (change) => {
      const current = fixture();
      const held = heldResponse();
      current.performFetch.mockResolvedValue(held.response);
      const { result, rerender } = renderHook(() => useOptimisticVote('tick-one', 1, null, 'tick'), current);
      act(() => result.current.toggle());
      expect(result.current.count).toBe(2);
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
      if (change === 'original-expiry-with-fresh-lease') await renew(current);
      else {
        current.switchAccount('owned-B');
        if (change === 'ABA') current.switchAccount('owned-A');
        selected.scope = current.scope();
        rerender();
      }
      await act(async () => held.release());
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.count).toBe(1);
      expect(result.current.voted).toBe(false);
      expect(current.performFetch).toHaveBeenCalledOnce();
    },
  );

  it.each(['entity', 'entity-type', 'ABA'] as const)(
    'does not reconcile a valid original SDK success into a recycled %s row',
    async (change) => {
      const current = fixture();
      const held = heldResponse();
      current.performFetch.mockResolvedValue(held.response);
      const { result, rerender } = renderHook(({ id, type }) => useOptimisticVote(id, 1, null, type), {
        ...current,
        initialProps: { id: 'tick-one', type: 'tick' as 'tick' | 'session' },
      });
      const originalToggle = result.current.toggle;
      act(() => originalToggle());
      await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
      if (change === 'entity-type') rerender({ id: 'tick-one', type: 'session' });
      else {
        rerender({ id: 'tick-two', type: 'tick' });
        if (change === 'ABA') rerender({ id: 'tick-one', type: 'tick' });
      }
      await act(async () => held.release());
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.count).toBe(1);
      expect(result.current.voted).toBe(false);
      act(() => originalToggle());
      expect(current.performFetch).toHaveBeenCalledOnce();
    },
  );
});
