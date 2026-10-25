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
// keyed on (boardName, climbUuid, angle), stays disabled while the sheet is closed
// or before a climb is selected, and a toggle busts its cache.

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// `favorites` is `requireAuthenticated` server-side, so the hook reads the
// session off the board adapter and refuses to fire without one. Mutable so the
// signed-out case can be exercised without re-mocking.
const adapterAuth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('@boardsesh/board-react', () => ({
  useBoardAdapter: () => adapterAuth,
}));

// The hooks barrel re-exports sibling hooks that transitively pull in
// react-native / expo-router (auth provider, you-data, social, session-detail).
// useFavoriteStatus + useToggleFavorite are pure React Query and touch none of
// them, so stub the heavy re-exports so the barrel parses under the node SSR
// transform.
vi.mock('react-native', () => ({}));
vi.mock('../use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
vi.mock('../use-similar-climbs', () => ({ useSimilarClimbs: vi.fn() }));
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
vi.mock('../use-delete-account', () => ({ useDeleteAccountInfo: vi.fn(), useDeleteAccount: vi.fn() }));
vi.mock('../use-integrations', () => ({
  useIntegrationStatuses: vi.fn(),
  useDisconnectIntegration: vi.fn(),
  useSetIntegrationAutoSync: vi.fn(),
  useSyncSessionToIntegration: vi.fn(),
}));

// The local-queue toggle path (#6002 freshness): off by default, so every other
// test here takes the network path as before.
const localQueue = vi.hoisted(() => ({
  db: null as { tag: string } | null,
  offlineEnabled: false,
  addFavoriteLocal: vi.fn(),
  removeFavoriteLocal: vi.fn(),
}));
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => localQueue.db }));
vi.mock('../../../../providers/feature-flags-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../providers/feature-flags-provider')>()),
  useOfflineDownloadsEnabled: () => localQueue.offlineEnabled,
}));
vi.mock('../../../../hooks/use-offline-mutations', () => ({
  addFavoriteLocal: localQueue.addFavoriteLocal,
  removeFavoriteLocal: localQueue.removeFavoriteLocal,
}));
vi.mock('../../../../offline/offline-sync-adapter', () => ({ drainMutationQueue: vi.fn(async () => undefined) }));

import { favoritesStore } from '@boardsesh/climb-actions';
import { smartPlaylistQueryKey } from '@boardsesh/playlists-react';
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
  localQueue.db = null;
  localQueue.offlineEnabled = false;
  requestMock.mockReset();
  adapterAuth.isAuthenticated = true;
  favoritesStore.reset();
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
    // The query keys the favorite on the supplied angle (favorites are per-angle
    // on the backend).
    expect(requestMock).toHaveBeenCalledWith(GET_FAVORITES, {
      boardName: 'kilter',
      climbUuids: ['climb-1'],
      angle: 40,
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

  // The anonymous read-only climb view opens the play drawer with
  // `enabled: isSheetOpen` for a visitor who has no account. Without this gate
  // every such open fired a GET_FAVORITES that `requireAuthenticated` rejects.
  it('does not fetch for a signed-out reader even when the caller enables it', async () => {
    adapterAuth.isAuthenticated = false;
    requestMock.mockResolvedValue({ favorites: ['climb-1'] });
    const { Wrapper } = makeWrapper();

    renderHook(() => useFavoriteStatus('kilter', 'climb-1', 40, { enabled: true }), { wrapper: Wrapper });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestMock).not.toHaveBeenCalled();
  });

  // The other half of the gate: the fix must not be "never fetch". A member on
  // the same climb still gets exactly one request, so the heart keeps working.
  it('still fetches once for a signed-in member on the same arguments', async () => {
    requestMock.mockResolvedValue({ favorites: ['climb-1'] });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useFavoriteStatus('kilter', 'climb-1', 40, { enabled: true }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledTimes(1);
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
      input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
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
      input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['favoriteStatus', 'kilter', 'climb-1', 40],
    });
  });

  // Climbs → Collection → Liked (#6002): un-hearting must drop the climb from the
  // filtered list and hearting must add it, on both toggle paths.
  it.each([
    ['the network toggle', false],
    ['the queued local toggle', true],
  ])('refreshes the climb search lists and Liked count after %s', async (_label, viaLocalQueue) => {
    localQueue.db = viaLocalQueue ? { tag: 'db' } : null;
    localQueue.offlineEnabled = viaLocalQueue;
    requestMock.mockResolvedValue({ toggleFavorite: { favorited: true } });
    const { queryClient, Wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const likedCountKey = ['searchClimbsCount', { boardName: 'kilter', onlyFavorited: true }];
    queryClient.setQueryData(likedCountKey, { searchClimbs: { totalCount: 1 } });

    const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
    await result.current.mutateAsync({
      input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
      currentlyFavorited: false,
    });

    if (viaLocalQueue) expect(localQueue.addFavoriteLocal).toHaveBeenCalled();
    else expect(localQueue.addFavoriteLocal).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['infiniteSearchClimbs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['searchClimbsCount'] });
    expect(queryClient.getQueryState(likedCountKey)?.isInvalidated).toBe(true);
  });

  // The climb list's hearts read `favoritesStore`, so the toggle owns keeping it
  // truthful — including when the network says no.
  it('writes the toggle into the shared store optimistically and confirms with server truth', async () => {
    requestMock.mockResolvedValue({ toggleFavorite: { favorited: true } });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
    await result.current.mutateAsync({
      input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
      currentlyFavorited: false,
    });

    expect(favoritesStore.getIsFavorited('climb-1')).toBe(true);
  });

  it('follows server truth when it contradicts the optimistic guess', async () => {
    // Already favourited on the server (another device got there first), so the
    // toggle removes it even though this client guessed "adding".
    requestMock.mockResolvedValue({ toggleFavorite: { favorited: false } });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
    await result.current.mutateAsync({
      input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
      currentlyFavorited: false,
    });

    expect(favoritesStore.getIsFavorited('climb-1')).toBe(false);
  });

  it('rolls the store back when the toggle fails', async () => {
    requestMock.mockRejectedValue(new Error('offline'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
    await expect(
      result.current.mutateAsync({
        input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
        currentlyFavorited: false,
      }),
    ).rejects.toThrow('offline');

    expect(favoritesStore.getIsFavorited('climb-1')).toBe(false);
  });

  // The store is a singleton scoped to one board+angle+user. A toggle that
  // resolves after the user switched angles must not paint its result onto the
  // list now showing a different angle.
  it('drops its store write when the favourite context changed while in flight', async () => {
    let resolveToggle: (value: { toggleFavorite: { favorited: boolean } }) => void = () => {};
    requestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToggle = resolve;
        }),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });

    const pending = result.current.mutateAsync({
      input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
      currentlyFavorited: false,
    });
    // Let onMutate run (React Query awaits it) so the request is actually in
    // flight and the optimistic write has landed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(favoritesStore.getIsFavorited('climb-1')).toBe(true);

    // The list re-scopes to another angle, clearing the store.
    favoritesStore.applyContext('kilter:25:1');
    resolveToggle({ toggleFavorite: { favorited: true } });
    await pending;

    expect(favoritesStore.getIsFavorited('climb-1')).toBe(false);
  });

  // Two taps in flight, both failing: the FIRST failure must not roll back over
  // the second tap's optimistic write, or the heart lands on the state of an
  // older attempt. Only the toggle whose value still stands rolls it back.
  it('does not let an older failed toggle stomp a newer one still in flight', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });

    // Tap 1 (add) fails slowly; tap 2 (remove, from the optimistic `true`)
    // fails fast, so its rollback to `true` lands before tap 1's rollback runs.
    let failFirst: (reason: Error) => void = () => {};
    requestMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    requestMock.mockRejectedValueOnce(new Error('second failed'));

    const first = result.current.mutateAsync({
      input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
      currentlyFavorited: false,
    });
    first.catch(() => {});
    expect(favoritesStore.getIsFavorited('climb-1')).toBe(true);

    await expect(
      result.current.mutateAsync({
        input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
        currentlyFavorited: true,
      }),
    ).rejects.toThrow('second failed');
    // Tap 2 rolled back to the state it started from.
    expect(favoritesStore.getIsFavorited('climb-1')).toBe(true);

    failFirst(new Error('first failed'));
    await expect(first).rejects.toThrow('first failed');

    // Tap 1's rollback would have written `false`. The guard sees the store no
    // longer holds tap 1's optimistic value and leaves tap 2's result standing.
    expect(favoritesStore.getIsFavorited('climb-1')).toBe(true);
  });

  // #5304: the Liked list loses an un-liked row at tap time. Both ways it can come
  // back must work from the cache alone, without a refetch.
  describe('Liked list rows', () => {
    const likedKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    function seedLiked(queryClient: QueryClient) {
      queryClient.setQueryData(likedKey, {
        pages: [{ climbs: [{ uuid: 'climb-0' }, { uuid: 'climb-1' }, { uuid: 'climb-2' }], totalCount: 3 }],
        pageParams: [0],
      });
    }
    function likedTotal(queryClient: QueryClient) {
      return queryClient.getQueryData<{ pages: { totalCount: number }[] }>(likedKey)?.pages[0].totalCount;
    }
    function likedUuids(queryClient: QueryClient) {
      return queryClient
        .getQueryData<{ pages: { climbs: { uuid: string }[] }[] }>(likedKey)
        ?.pages[0].climbs.map((climb) => climb.uuid);
    }

    it('puts the row back when the climb is liked again after an un-like', async () => {
      const { queryClient, Wrapper } = makeWrapper();
      seedLiked(queryClient);
      const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
      const input = { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 };

      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: false } });
      await result.current.mutateAsync({ input, currentlyFavorited: true });
      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-2']);

      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: true } });
      await result.current.mutateAsync({ input, currentlyFavorited: false });
      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-1', 'climb-2']);
    });

    it('puts the row back when the un-like fails, with no request to do it', async () => {
      const { queryClient, Wrapper } = makeWrapper();
      seedLiked(queryClient);
      const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });

      requestMock.mockRejectedValueOnce(new Error('offline'));
      await expect(
        result.current.mutateAsync({
          input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
          currentlyFavorited: true,
        }),
      ).rejects.toThrow('offline');

      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-1', 'climb-2']);
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('puts the row back when the un-like fails after a board or angle change', async () => {
      const { queryClient, Wrapper } = makeWrapper();
      seedLiked(queryClient);
      favoritesStore.applyContext('kilter|40|u');
      favoritesStore.setIsFavorited('climb-1', true);
      const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });

      let rejectUnlike: (error: Error) => void = () => undefined;
      requestMock.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectUnlike = reject;
        }),
      );
      const unlike = result.current.mutateAsync({
        input: { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 },
        currentlyFavorited: true,
      });
      await waitFor(() => expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-2']));

      // The climber moves the board to 25° while the un-like is in flight.
      favoritesStore.applyContext('kilter|25|u');
      rejectUnlike(new Error('offline'));
      await expect(unlike).rejects.toThrow('offline');

      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-1', 'climb-2']);
      expect(likedTotal(queryClient)).toBe(3);
      // The 25° heart store never held this climb, so the 40° rollback stays out.
      expect(favoritesStore.getIsFavorited('climb-1')).toBe(false);
    });

    it('leaves the Liked rows to a newer toggle when an older one fails after a board change', async () => {
      const { queryClient, Wrapper } = makeWrapper();
      seedLiked(queryClient);
      const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
      const input = { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 };

      // Tap 1 un-likes and hangs; tap 2 likes; tap 3 un-likes and hangs.
      let rejectFirstUnlike: (error: Error) => void = () => undefined;
      requestMock.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirstUnlike = reject;
        }),
      );
      const firstUnlike = result.current.mutateAsync({ input, currentlyFavorited: true });
      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: true } });
      await result.current.mutateAsync({ input, currentlyFavorited: false });
      let resolveLastUnlike: (value: unknown) => void = () => undefined;
      requestMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLastUnlike = resolve;
        }),
      );
      const lastUnlike = result.current.mutateAsync({ input, currentlyFavorited: true });
      await waitFor(() => expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-2']));

      // Tap 1's failure must not put the row back over tap 3's un-like.
      favoritesStore.applyContext('kilter|25|u');
      rejectFirstUnlike(new Error('offline'));
      await expect(firstUnlike).rejects.toThrow('offline');
      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-2']);
      expect(likedTotal(queryClient)).toBe(2);

      resolveLastUnlike({ toggleFavorite: { favorited: false } });
      await lastUnlike;
    });

    it('takes the row out again when a re-like fails, and a later like still puts it back', async () => {
      const { queryClient, Wrapper } = makeWrapper();
      seedLiked(queryClient);
      const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
      const input = { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 };

      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: false } });
      await result.current.mutateAsync({ input, currentlyFavorited: true });

      requestMock.mockRejectedValueOnce(new Error('offline'));
      await expect(result.current.mutateAsync({ input, currentlyFavorited: false })).rejects.toThrow('offline');
      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-2']);
      expect(likedTotal(queryClient)).toBe(2);
      expect(favoritesStore.getIsFavorited('climb-1')).toBe(false);

      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: true } });
      await result.current.mutateAsync({ input, currentlyFavorited: false });
      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-1', 'climb-2']);
      expect(likedTotal(queryClient)).toBe(3);
    });

    it('takes the row out again when a queued re-like fails to write locally', async () => {
      localQueue.offlineEnabled = true;
      localQueue.db = { tag: 'db' };
      localQueue.removeFavoriteLocal.mockResolvedValueOnce(undefined);
      localQueue.addFavoriteLocal.mockRejectedValueOnce(new Error('disk full'));
      const { queryClient, Wrapper } = makeWrapper();
      seedLiked(queryClient);
      const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
      const input = { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 };

      await result.current.mutateAsync({ input, currentlyFavorited: true });
      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-2']);

      await expect(result.current.mutateAsync({ input, currentlyFavorited: false })).rejects.toThrow('disk full');
      expect(likedUuids(queryClient)).toEqual(['climb-0', 'climb-2']);
      expect(likedTotal(queryClient)).toBe(2);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('refetches an on-screen Liked list after a like, but only marks it stale after an un-like', async () => {
      const { queryClient, Wrapper } = makeWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useToggleFavorite(), { wrapper: Wrapper });
      const input = { boardName: 'kilter', climbUuid: 'climb-1', angle: 40 };

      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: true } });
      await result.current.mutateAsync({ input, currentlyFavorited: false });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['smartPlaylist', 'LIKED_CLIMBS'],
        refetchType: 'active',
      });

      invalidateSpy.mockClear();
      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: false } });
      await result.current.mutateAsync({ input, currentlyFavorited: true });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['smartPlaylist', 'LIKED_CLIMBS'],
        refetchType: 'none',
      });
    });
  });
});
