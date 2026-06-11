// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_FAVORITES } from '@boardsesh/graphql/operations/favorites';

// The play drawer's heart was a local boolean hard-reset to false on every open,
// so it never reflected real favorite status and a single tap on an already-
// favorited climb silently un-favorited it. useFavoriteStatus is the server-truth
// seam the drawer now reads. These tests pin: it reports the real favorite state
// keyed by climb UUID, stays disabled while the sheet is closed or before a
// climb is selected, and a toggle busts its cache.

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// The hooks barrel re-exports sibling hooks that transitively pull in
// react-native / expo-router (auth provider, you-data, social, session-detail).
// useFavoriteStatus + useToggleFavorite are pure React Query and touch none of
// them, so stub the heavy re-exports so the barrel parses under the node SSR
// transform.
vi.mock('react-native', () => ({}));
vi.mock('../use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
vi.mock('../use-beta-link-preview', () => ({ useBetaLinkPreview: vi.fn() }));
vi.mock('../use-mobile-climb-actions-data', () => ({ useMobileClimbActionsData: vi.fn() }));
vi.mock('../use-you-data', () => ({
  useAllBoardsTicks: vi.fn(),
  useUserProfileStats: vi.fn(),
  useUserClimbPercentile: vi.fn(),
  useUserAscentsFeed: vi.fn(),
  useSessionGroupedFeed: vi.fn(),
}));
vi.mock('../use-you-profile-data', () => ({ useYouProfileData: vi.fn() }));
vi.mock('../use-social', () => ({
  useVote: vi.fn(),
  useBulkVoteSummaries: vi.fn(),
  useComments: vi.fn(),
  useAddComment: vi.fn(),
}));
vi.mock('../use-session-detail', () => ({ useSessionDetail: vi.fn(), useSessionPreview: vi.fn() }));

import { useFavoriteStatus, useToggleFavorite } from '../index';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useFavoriteStatus', () => {
  it('reports a climb as favorited when the server returns its uuid', async () => {
    requestMock.mockResolvedValue({ favorites: ['climb-1'] });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useFavoriteStatus('kilter', 'climb-1', 40, { enabled: true }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(true);
    expect(requestMock).toHaveBeenCalledWith(GET_FAVORITES, {
      climbUuids: ['climb-1'],
    });
  });

  it('reports a climb as not favorited when the server omits it', async () => {
    requestMock.mockResolvedValue({ favorites: [] });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useFavoriteStatus('kilter', 'climb-1', 40, { enabled: true }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(false);
  });

  it('does not fetch while disabled (sheet closed)', async () => {
    requestMock.mockResolvedValue({ favorites: ['climb-1'] });
    const { Wrapper } = makeWrapper();

    renderHook(() => useFavoriteStatus('kilter', 'climb-1', 40, { enabled: false }), { wrapper: Wrapper });

    // Give React Query a tick; nothing should fire while disabled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does not fetch before a climb is selected (null uuid)', async () => {
    requestMock.mockResolvedValue({ favorites: [] });
    const { Wrapper } = makeWrapper();

    renderHook(() => useFavoriteStatus('kilter', null, 40, { enabled: true }), { wrapper: Wrapper });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('useToggleFavorite', () => {
  it('returns the server-authoritative favorited value so callers can reconcile', async () => {
    requestMock.mockResolvedValue({ toggleFavorite: { favorited: false } });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });

    const response = await result.current.mutateAsync({
      input: { climbUuid: 'climb-1' },
    });

    // A toggle on an already-favorited climb returns favorited:false — the heart
    // must follow this, not the always-added optimistic guess.
    expect(response.toggleFavorite.favorited).toBe(false);
  });

  it('busts the per-climb favorite-status cache on success', async () => {
    requestMock.mockResolvedValueOnce({ favorites: ['climb-1'] });
    const { queryClient, Wrapper } = makeWrapper();

    // Seed a favorite-status query so we can observe its invalidation.
    const statusHook = renderHook(() => useFavoriteStatus('kilter', 'climb-1', 40, { enabled: true }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(statusHook.result.current.isSuccess).toBe(true));

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: false } });
    const toggleHook = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
    await toggleHook.result.current.mutateAsync({
      input: { climbUuid: 'climb-1' },
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['favoriteStatus', 'climb-1'],
    });
  });
});
