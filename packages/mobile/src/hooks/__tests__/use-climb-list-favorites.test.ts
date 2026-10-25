// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Run scheduled interaction callbacks immediately — this hook's deferral is
// covered by the shared `scheduleIdleTask` contract, not by these tests.
const { scheduleIdleTask, request, isAuthenticated, storedUser, refresh, database, pendingOverrides } = vi.hoisted(
  () => ({
    scheduleIdleTask: vi.fn((callback: () => void) => {
      callback();
      return { cancel: vi.fn() };
    }),
    request: vi.fn(),
    refresh: { epoch: 0 },
    isAuthenticated: { value: true },
    storedUser: { userId: 'user-a' as string | undefined, isLoading: false },
    database: { handle: null as object | null },
    pendingOverrides: vi.fn(),
  }),
);

vi.mock('../../lib/schedule-idle-task', () => ({ scheduleIdleTask }));
vi.mock('../../lib/graphql/offline-request', () => ({ offlineAwareRequest: request }));
vi.mock('../use-user-read-refresh', () => ({ useUserReadRefresh: () => refresh.epoch }));
vi.mock('../../db', () => ({ getDatabaseHandle: () => database.handle }));
vi.mock('../../db/queries/get-favorite-status-local', () => ({ getPendingFavoriteOverridesLocal: pendingOverrides }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: isAuthenticated.value }),
}));
vi.mock('../use-current-user-id', () => ({
  useStoredUserId: () => storedUser,
}));

import { favoritesStore } from '@boardsesh/climb-actions';
import { useClimbListFavorites } from '../use-climb-list-favorites';
import { invalidatePrivacySnapshots } from '../../lib/privacy/privacy-cache';

// A promise the request resolves with, awaited via a microtask flush so the
// hook's async batch completes before assertions.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useClimbListFavorites', () => {
  beforeEach(() => {
    // Also forgets the context the store held, so each test starts unscoped.
    favoritesStore.reset();
    request.mockReset();
    refresh.epoch = 0;
    scheduleIdleTask.mockClear();
    isAuthenticated.value = true;
    storedUser.userId = 'user-a';
    storedUser.isLoading = false;
    database.handle = null;
    pendingOverrides.mockReset().mockResolvedValue(new Map());
  });

  it('refetches already displayed hearts after local-read recovery', async () => {
    request.mockResolvedValueOnce({ favorites: ['a'] }).mockResolvedValueOnce({ favorites: [] });
    const climbUuids = ['a'];
    const { rerender } = renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids }));
    await flush();
    expect(favoritesStore.getIsFavorited('a')).toBe(true);
    refresh.epoch += 1;
    rerender();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(favoritesStore.getIsFavorited('a')).toBe(false);
  });

  it('keeps queued adds and removes when reconnect reads the server before the outbox drains', async () => {
    const climbUuids = ['added', 'removed'];
    request.mockResolvedValue({ favorites: ['removed'] });
    const { rerender } = renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids }));
    await flush();
    favoritesStore.setIsFavorited('added', true);
    favoritesStore.setIsFavorited('removed', false);
    database.handle = {};
    pendingOverrides.mockResolvedValue(
      new Map([
        ['added', true],
        ['removed', false],
      ]),
    );
    refresh.epoch += 1;
    rerender();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(favoritesStore.getIsFavorited('added')).toBe(true);
    expect(favoritesStore.getIsFavorited('removed')).toBe(false);
  });

  it('restores queued favorite intent on a new mount before the server sees it', async () => {
    database.handle = {};
    pendingOverrides.mockResolvedValue(
      new Map([
        ['added', true],
        ['removed', false],
      ]),
    );
    request.mockResolvedValue({ favorites: ['removed'] });
    const climbUuids = ['added', 'removed'];
    renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids }));
    await flush();
    expect(pendingOverrides).toHaveBeenCalledWith(database.handle, climbUuids, 'user-a');
    expect(favoritesStore.getIsFavorited('added')).toBe(true);
    expect(favoritesStore.getIsFavorited('removed')).toBe(false);
  });

  it('keeps captured intent when the outbox drains before a stale server response settles', async () => {
    database.handle = {};
    pendingOverrides.mockResolvedValue(new Map([['added', true]]));
    let finishRead: ((response: { favorites: string[] }) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const climbUuids = ['added'];
    renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids }));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    pendingOverrides.mockResolvedValue(new Map());
    finishRead?.({ favorites: [] });
    await flush();
    expect(favoritesStore.getIsFavorited('added')).toBe(true);
  });

  it('lets a newer toggle override the queued intent captured before the read', async () => {
    database.handle = {};
    pendingOverrides.mockResolvedValue(new Map([['added', true]]));
    let finishRead: ((response: { favorites: string[] }) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const climbUuids = ['added'];
    renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids }));
    await flush();
    favoritesStore.setIsFavorited('added', false);
    finishRead?.({ favorites: [] });
    await flush();
    expect(favoritesStore.getIsFavorited('added')).toBe(false);
  });

  it('writes the favorited subset of the visible climbs into the store', async () => {
    request.mockResolvedValue({ favorites: ['b'] });

    renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids: ['a', 'b'] }));
    await flush();

    expect(favoritesStore.getIsFavorited('a')).toBe(false);
    expect(favoritesStore.getIsFavorited('b')).toBe(true);
    expect(request).toHaveBeenCalledWith(expect.anything(), {
      boardName: 'kilter',
      climbUuids: ['a', 'b'],
      angle: 40,
    });
  });

  it('drops a pending override read across a credential change before auth rerenders', async () => {
    database.handle = {};
    let finishOverrides: ((overrides: Map<string, boolean>) => void) | undefined;
    pendingOverrides.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOverrides = resolve;
        }),
    );
    request.mockResolvedValue({ favorites: [] });
    const climbUuids = ['added'];
    renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids }));
    await flush();
    expect(request).not.toHaveBeenCalled();
    invalidatePrivacySnapshots('credential');
    finishOverrides?.(new Map([['added', true]]));
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(favoritesStore.getIsFavorited('added')).toBe(false);
  });

  it('keeps earlier pages favorited when a later page comes back empty', async () => {
    request.mockResolvedValueOnce({ favorites: ['first-page'] });

    const { rerender } = renderHook(
      (props: { climbUuids: string[] }) => useClimbListFavorites({ boardName: 'kilter', angle: 40, ...props }),
      { initialProps: { climbUuids: ['first-page'] } },
    );
    await flush();
    expect(favoritesStore.getIsFavorited('first-page')).toBe(true);

    // Paging in a second screenful only asks about the NEW uuids, so the merge
    // must not treat "not in this response" as "unfavourite everything".
    request.mockResolvedValueOnce({ favorites: [] });
    rerender({ climbUuids: ['first-page', 'second-page'] });
    await flush();

    expect(favoritesStore.getIsFavorited('first-page')).toBe(true);
    expect(favoritesStore.getIsFavorited('second-page')).toBe(false);
  });

  it('requests each uuid once as the visible window grows', async () => {
    request.mockResolvedValue({ favorites: [] });

    const { rerender } = renderHook(
      (props: { climbUuids: string[] }) => useClimbListFavorites({ boardName: 'kilter', angle: 40, ...props }),
      { initialProps: { climbUuids: ['a'] } },
    );
    await flush();
    rerender({ climbUuids: ['a', 'b'] });
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(expect.anything(), {
      boardName: 'kilter',
      climbUuids: ['b'],
      angle: 40,
    });
  });

  it('clears the store and refetches when the angle changes — favorites are per-angle', async () => {
    request.mockResolvedValue({ favorites: ['a'] });

    const { rerender } = renderHook(
      (props: { angle: number }) => useClimbListFavorites({ boardName: 'kilter', climbUuids: ['a'], ...props }),
      { initialProps: { angle: 40 } },
    );
    await flush();
    expect(favoritesStore.getIsFavorited('a')).toBe(true);

    request.mockResolvedValue({ favorites: [] });
    rerender({ angle: 25 });
    await flush();

    expect(favoritesStore.getIsFavorited('a')).toBe(false);
    expect(request).toHaveBeenLastCalledWith(expect.anything(), {
      boardName: 'kilter',
      climbUuids: ['a'],
      angle: 25,
    });
  });

  // A shared device where the account switch never renders a signed-out state
  // between the two users: the auth bit stays 1, so only the id distinguishes
  // whose favourites the store is holding.
  it('clears one user\u2019s hearts when another signs in at the same board and angle', async () => {
    request.mockResolvedValue({ favorites: ['a'] });
    const climbUuids = ['a'];
    const { rerender } = renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids }));
    await flush();
    expect(favoritesStore.getIsFavorited('a')).toBe(true);

    request.mockResolvedValue({ favorites: [] });
    storedUser.userId = 'user-b';
    rerender();
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
    expect(favoritesStore.getIsFavorited('a')).toBe(false);
  });

  it('waits for the user id to resolve before fetching', async () => {
    storedUser.userId = undefined;
    storedUser.isLoading = true;

    const { rerender } = renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids: ['a'] }));
    await flush();
    expect(request).not.toHaveBeenCalled();

    // Fetching under a placeholder key would only be reset and refetched the
    // moment the real id landed.
    request.mockResolvedValue({ favorites: ['a'] });
    storedUser.userId = 'user-a';
    storedUser.isLoading = false;
    rerender();
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
    expect(favoritesStore.getIsFavorited('a')).toBe(true);
  });

  // The batch is deferred past the fling, so there's a real window in which the
  // user hearts a climb the in-flight lookup is about to report as unfavourited.
  it('does not let a lookup that raced a toggle clear the newly set heart', async () => {
    let resolveLookup: (value: { favorites: string[] }) => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );

    renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids: ['a'] }));
    await flush();

    // The toggle lands first; the server's pre-toggle answer arrives after.
    favoritesStore.setIsFavorited('a', true);
    resolveLookup({ favorites: [] });
    await flush();

    expect(favoritesStore.getIsFavorited('a')).toBe(true);
  });

  it('re-queues a cancelled batch in time for the replacement fetch to pick it up', async () => {
    let resolveFirst: (value: { favorites: string[] }) => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { rerender } = renderHook(
      (props: { climbUuids: string[] }) => useClimbListFavorites({ boardName: 'kilter', angle: 40, ...props }),
      { initialProps: { climbUuids: ['a'] } },
    );
    await flush();

    // The window changes while 'a' is still in flight. The cleanup must release
    // 'a' before the replacement effect computes what to fetch, so the new run
    // asks about it again rather than skipping it as already-fetched.
    request.mockResolvedValue({ favorites: ['a'] });
    rerender({ climbUuids: ['a', 'b'] });
    await flush();
    resolveFirst({ favorites: [] });
    await flush();

    expect(favoritesStore.getIsFavorited('a')).toBe(true);
  });

  it('does not fetch while signed out', async () => {
    isAuthenticated.value = false;

    renderHook(() => useClimbListFavorites({ boardName: 'kilter', angle: 40, climbUuids: ['a'] }));
    await flush();

    expect(request).not.toHaveBeenCalled();
  });

  // >500 visible climbs is two chunks. Navigating away (or the window changing)
  // between them used to leave the second chunk's uuids marked as fetched but
  // never fetched, so those hearts stayed dark for the rest of the session.
  it('re-queues the chunks it never merged when a multi-chunk fetch is cancelled', async () => {
    const manyUuids = Array.from({ length: 600 }, (_index, position) => `climb-${position}`);

    let resolveSecondChunk: (value: { favorites: string[] }) => void = () => {};
    request.mockResolvedValueOnce({ favorites: [] });
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecondChunk = resolve;
        }),
    );

    const { rerender } = renderHook(
      (props: { climbUuids: string[] }) => useClimbListFavorites({ boardName: 'kilter', angle: 40, ...props }),
      { initialProps: { climbUuids: manyUuids } },
    );
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    // The window changes while chunk 2 is in flight, cancelling this batch.
    rerender({ climbUuids: [...manyUuids, 'climb-600'] });
    await flush();
    resolveSecondChunk({ favorites: [] });
    await flush();

    // The 100 uuids chunk 2 never merged are retryable again.
    request.mockResolvedValue({ favorites: ['climb-550'] });
    rerender({ climbUuids: [...manyUuids, 'climb-600', 'climb-601'] });
    await flush();

    expect(favoritesStore.getIsFavorited('climb-550')).toBe(true);
  });

  it('retries a failed batch on the next visible-window change', async () => {
    request.mockRejectedValueOnce(new Error('offline'));

    const { rerender } = renderHook(
      (props: { climbUuids: string[] }) => useClimbListFavorites({ boardName: 'kilter', angle: 40, ...props }),
      { initialProps: { climbUuids: ['a'] } },
    );
    await flush();

    request.mockResolvedValue({ favorites: ['a'] });
    rerender({ climbUuids: ['a', 'b'] });
    await flush();

    expect(favoritesStore.getIsFavorited('a')).toBe(true);
  });
});
