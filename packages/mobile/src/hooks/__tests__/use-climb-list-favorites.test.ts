// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Run scheduled interaction callbacks immediately — this hook's deferral is
// covered by the shared `runAfterInteractions` contract, not by these tests.
const { runAfterInteractions, request, isAuthenticated } = vi.hoisted(() => ({
  runAfterInteractions: vi.fn((callback: () => void) => {
    callback();
    return { cancel: vi.fn() };
  }),
  request: vi.fn(),
  isAuthenticated: { value: true },
}));

vi.mock('react-native', () => ({ InteractionManager: { runAfterInteractions } }));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: isAuthenticated.value }),
}));

import { favoritesStore } from '@boardsesh/climb-actions';
import { useClimbListFavorites } from '../use-climb-list-favorites';

// A promise the request resolves with, awaited via a microtask flush so the
// hook's async batch completes before assertions.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useClimbListFavorites', () => {
  beforeEach(() => {
    // Also forgets the context the store held, so each test starts unscoped.
    favoritesStore.reset();
    request.mockReset();
    runAfterInteractions.mockClear();
    isAuthenticated.value = true;
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
