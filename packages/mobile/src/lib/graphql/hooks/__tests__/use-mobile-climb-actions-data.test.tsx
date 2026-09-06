// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import { TOGGLE_FAVORITE } from '@boardsesh/graphql/operations/favorites';
import { favoritesStore } from '@boardsesh/climb-actions';
import {
  GET_ALL_USER_PLAYLISTS,
  ADD_CLIMB_TO_PLAYLIST,
  REMOVE_CLIMB_FROM_PLAYLIST,
  CREATE_PLAYLIST,
} from '@boardsesh/graphql/operations/playlists';

// `getHttpClient` is the single graphql-request entry point the hook touches —
// mock at the module boundary so we can assert what gets sent and what gets
// returned without spinning up a server.
const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// AuthProvider transitively imports expo-router, which jsdom can't satisfy.
// The hook only needs `isAuthenticated` + `isLoading` from useAuth so we stub
// it directly.
vi.mock('../../../../providers/auth-provider', () => ({
  useAuth: vi.fn(),
}));

// Same story for useActiveBoard — we want to control whether there's a
// selected board on each test.
vi.mock('../../use-active-board', () => ({
  useActiveBoard: vi.fn(),
}));

// The favorite dual-write path is gated on BOTH the offline-engine feature
// flag and a live DB handle. Default both off/null so every pre-existing test
// keeps exercising the plain network toggle; the gating describe below flips
// them per test.
let offlineEnabled = false;
vi.mock('../../../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => offlineEnabled,
}));

const getDatabaseHandleMock = vi.fn((): unknown => null);
vi.mock('../../../../db', () => ({
  getDatabaseHandle: () => getDatabaseHandleMock(),
}));

const addFavoriteLocalMock = vi.fn(async (..._args: unknown[]) => {});
const removeFavoriteLocalMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../../../hooks/use-offline-mutations', () => ({
  addFavoriteLocal: (...args: unknown[]) => addFavoriteLocalMock(...args),
  removeFavoriteLocal: (...args: unknown[]) => removeFavoriteLocalMock(...args),
}));

const drainMutationQueueMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: (...args: unknown[]) => drainMutationQueueMock(...args),
}));

import { useMobileClimbActionsData } from '../use-mobile-climb-actions-data';
import { useAuth } from '../../../../providers/auth-provider';
import { useActiveBoard } from '../../use-active-board';

const useAuthMock = vi.mocked(useAuth);
const useActiveBoardMock = vi.mocked(useActiveBoard);

const kilterBoard = {
  uuid: 'b-1',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 2,
  setIds: '3',
  angle: 40,
} as unknown as UserBoard;

const mkPlaylist = (uuid: string, name: string): Playlist => ({
  id: uuid,
  uuid,
  name,
  isPublic: false,
  climbCount: 0,
  boardType: 'kilter',
  layoutId: 1,
  followerCount: 0,
  isFollowedByMe: false,
  isPinnedByMe: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

// Each test gets a fresh QueryClient so cached playlists / mutations don't
// leak between cases. The wrapper factory also surfaces the client so a few
// tests can read/write cache state directly to assert the optimistic prepend
// and the auth-boundary cache-clear behaviour.
function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

function signedIn() {
  useAuthMock.mockReturnValue({
    isAuthenticated: true,
    isLoading: false,
    signInWithApple: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithGoogleWeb: vi.fn(),
    signInWithAppleWeb: vi.fn(),
    signInWithCredentials: vi.fn(),
    register: vi.fn(),
    signOut: vi.fn(),
    refreshAuthState: vi.fn(),
  });
}

function signedOut() {
  useAuthMock.mockReturnValue({
    isAuthenticated: false,
    isLoading: false,
    signInWithApple: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithGoogleWeb: vi.fn(),
    signInWithAppleWeb: vi.fn(),
    signInWithCredentials: vi.fn(),
    register: vi.fn(),
    signOut: vi.fn(),
    refreshAuthState: vi.fn(),
  });
}

function withActiveBoard(board: UserBoard | null) {
  // useActiveBoard returns a React Query result; the hook only ever reads
  // `.data`, so a partial shape is enough.
  useActiveBoardMock.mockReturnValue({ data: board } as unknown as ReturnType<typeof useActiveBoard>);
}

describe('useMobileClimbActionsData', () => {
  beforeEach(() => {
    requestMock.mockReset();
    useAuthMock.mockReset();
    useActiveBoardMock.mockReset();
    getDatabaseHandleMock.mockReset();
    getDatabaseHandleMock.mockReturnValue(null);
    addFavoriteLocalMock.mockClear();
    removeFavoriteLocalMock.mockClear();
    drainMutationQueueMock.mockClear();
    // The toggle reads its "currently favorited" from — and writes its result
    // back into — the shared singleton store, so a previous test's toggle would
    // otherwise decide the next one's direction.
    favoritesStore.reset();
    offlineEnabled = false;
    signedIn();
    withActiveBoard(kilterBoard);
  });

  describe('playlists query', () => {
    it('does not fire while unauthenticated', async () => {
      signedOut();
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      // Give React Query a tick to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requestMock).not.toHaveBeenCalled();
      expect(result.current.playlistsProviderProps.playlists).toEqual([]);
    });

    it('fires GET_ALL_USER_PLAYLISTS when authenticated and exposes the result', async () => {
      const playlists = [mkPlaylist('p-1', 'Hard sends'), mkPlaylist('p-2', 'V4 grind')];
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists } });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      await waitFor(() => expect(result.current.playlistsProviderProps.playlists).toEqual(playlists));
      expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, { input: { pageSize: 200 } });
    });
  });

  describe('toggleFavorite', () => {
    it('returns false immediately when unauthenticated, without hitting the network', async () => {
      signedOut();
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      await expect(result.current.favoritesProviderProps.toggleFavorite('climb-x')).resolves.toBe(false);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('sends boardName + angle from the active board and returns the favorited flag', async () => {
      // First the playlists query, then the favorite mutation.
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });
      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: true } });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      await expect(result.current.favoritesProviderProps.toggleFavorite('climb-x')).resolves.toBe(true);
      expect(requestMock).toHaveBeenCalledWith(TOGGLE_FAVORITE, {
        input: { boardName: 'kilter', climbUuid: 'climb-x', angle: 40 },
      });
    });

    it('rejects with a helpful error when no active board is selected', async () => {
      withActiveBoard(null);
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      await expect(result.current.favoritesProviderProps.toggleFavorite('climb-x')).rejects.toThrow(/no active board/);
    });

    it('rejects when the active board has no angle (no silent angle-0 fallback)', async () => {
      // Active board with angle missing — common during a board switch before
      // the angle picker has been resolved. Defaulting to 0 would silently
      // file the favorite under the wrong climb variant.
      withActiveBoard({ ...kilterBoard, angle: null } as unknown as UserBoard);
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      await expect(result.current.favoritesProviderProps.toggleFavorite('climb-x')).rejects.toThrow(/no angle/);
      // Server must not have been called with a fabricated angle.
      expect(requestMock).not.toHaveBeenCalledWith(
        TOGGLE_FAVORITE,
        expect.objectContaining({ input: expect.objectContaining({ angle: 0 }) }),
      );
    });

    it('offline flag ON + DB handle: writes locally and schedules a drain, no network toggle', async () => {
      offlineEnabled = true;
      getDatabaseHandleMock.mockReturnValue({ tag: 'db' });
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      await expect(result.current.favoritesProviderProps.toggleFavorite('climb-x')).resolves.toBe(true);
      expect(addFavoriteLocalMock).toHaveBeenCalledTimes(1);
      expect(drainMutationQueueMock).toHaveBeenCalledTimes(1);
      expect(requestMock).not.toHaveBeenCalledWith(TOGGLE_FAVORITE, expect.anything());
    });

    it('offline flag OFF + DB handle: hits the network toggle, never the local write (pre-offline behavior)', async () => {
      offlineEnabled = false;
      getDatabaseHandleMock.mockReturnValue({ tag: 'db' });
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });
      requestMock.mockResolvedValueOnce({ toggleFavorite: { favorited: true } });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      await expect(result.current.favoritesProviderProps.toggleFavorite('climb-x')).resolves.toBe(true);
      expect(requestMock).toHaveBeenCalledWith(TOGGLE_FAVORITE, {
        input: { boardName: 'kilter', climbUuid: 'climb-x', angle: 40 },
      });
      expect(addFavoriteLocalMock).not.toHaveBeenCalled();
      expect(removeFavoriteLocalMock).not.toHaveBeenCalled();
      expect(drainMutationQueueMock).not.toHaveBeenCalled();
    });

    // The store holds one board+angle+user at a time. A toggle fired at 40°
    // that resolves after the user moved to 25° must not paint that list.
    it('does not write server truth into a store that was re-scoped mid-flight', async () => {
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });
      let resolveToggle: (value: { toggleFavorite: { favorited: boolean } }) => void = () => {};
      requestMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveToggle = resolve;
          }),
      );

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      const pending = result.current.favoritesProviderProps.toggleFavorite('climb-x');
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(TOGGLE_FAVORITE, expect.anything()));

      favoritesStore.applyContext('kilter:25:1');
      resolveToggle({ toggleFavorite: { favorited: true } });
      await pending;

      expect(favoritesStore.getIsFavorited('climb-x')).toBe(false);
    });
  });

  describe('addToPlaylist + removeFromPlaylist', () => {
    it('addToPlaylist forwards { playlistId, climbUuid, angle } to ADD_CLIMB_TO_PLAYLIST', async () => {
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });
      requestMock.mockResolvedValueOnce({ addClimbToPlaylist: { wasAlreadyInPlaylist: false } });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      await result.current.playlistsProviderProps.addToPlaylist('p-1', 'climb-x', 50);
      expect(requestMock).toHaveBeenCalledWith(ADD_CLIMB_TO_PLAYLIST, {
        input: { playlistId: 'p-1', climbUuid: 'climb-x', angle: 50 },
      });
    });

    it('removeFromPlaylist forwards { playlistId, climbUuid } to REMOVE_CLIMB_FROM_PLAYLIST', async () => {
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });
      requestMock.mockResolvedValueOnce({ removeClimbFromPlaylist: true });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      await result.current.playlistsProviderProps.removeFromPlaylist('p-1', 'climb-x');
      expect(requestMock).toHaveBeenCalledWith(REMOVE_CLIMB_FROM_PLAYLIST, {
        input: { playlistId: 'p-1', climbUuid: 'climb-x' },
      });
    });

    it('invalidates the playlist detail caches and bumps climbCount after addToPlaylist resolves', async () => {
      // Seed the picker cache so the optimistic climbCount bump is observable.
      requestMock.mockResolvedValueOnce({
        allUserPlaylists: { playlists: [mkPlaylist('p-1', 'Hard sends')] },
      });
      requestMock.mockResolvedValueOnce({ addClimbToPlaylist: { wasAlreadyInPlaylist: false } });

      const { queryClient, Wrapper } = makeWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists.length).toBe(1));

      await act(async () => {
        await result.current.playlistsProviderProps.addToPlaylist('p-1', 'climb-x', 50);
      });

      // The detail screen keys its climb list + metadata by playlist uuid; a
      // prefix invalidation refreshes them after the add lands.
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['playlistClimbs', 'p-1'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['playlist', 'p-1'] });
      // The picker's count subtitle reflects the add immediately.
      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])?.[0].climbCount).toBe(1);
    });

    it('invalidates the playlist detail caches and decrements climbCount after removeFromPlaylist resolves', async () => {
      requestMock.mockResolvedValueOnce({
        allUserPlaylists: { playlists: [{ ...mkPlaylist('p-1', 'Hard sends'), climbCount: 3 }] },
      });
      requestMock.mockResolvedValueOnce({ removeClimbFromPlaylist: true });

      const { queryClient, Wrapper } = makeWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists.length).toBe(1));

      await act(async () => {
        await result.current.playlistsProviderProps.removeFromPlaylist('p-1', 'climb-x');
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['playlistClimbs', 'p-1'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['playlist', 'p-1'] });
      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])?.[0].climbCount).toBe(2);
    });

    it('does not drop climbCount below zero on removeFromPlaylist', async () => {
      requestMock.mockResolvedValueOnce({
        allUserPlaylists: { playlists: [{ ...mkPlaylist('p-1', 'Empty'), climbCount: 0 }] },
      });
      requestMock.mockResolvedValueOnce({ removeClimbFromPlaylist: true });

      const { queryClient, Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists.length).toBe(1));

      await act(async () => {
        await result.current.playlistsProviderProps.removeFromPlaylist('p-1', 'climb-x');
      });

      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])?.[0].climbCount).toBe(0);
    });

    // #4014: the picker sends an add whenever its (possibly stale) membership
    // cache says "not a member", so re-adding a climb the playlist already
    // holds is a normal tap, not an error. The server reports the no-op and the
    // cached count must stay put.
    it('leaves climbCount alone when the server reports the climb was already in the playlist', async () => {
      requestMock.mockResolvedValueOnce({
        allUserPlaylists: { playlists: [{ ...mkPlaylist('p-1', 'Hard sends'), climbCount: 4 }] },
      });
      requestMock.mockResolvedValueOnce({ addClimbToPlaylist: { wasAlreadyInPlaylist: true } });

      const { queryClient, Wrapper } = makeWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists.length).toBe(1));

      await act(async () => {
        await result.current.playlistsProviderProps.addToPlaylist('p-1', 'climb-x', 50);
      });

      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])?.[0].climbCount).toBe(4);
      // The detail caches still refresh — the climb list may have been changed
      // by whoever inserted the row.
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['playlistClimbs', 'p-1'] });
    });

    it('leaves climbCount alone when removeFromPlaylist deleted nothing', async () => {
      requestMock.mockResolvedValueOnce({
        allUserPlaylists: { playlists: [{ ...mkPlaylist('p-1', 'Hard sends'), climbCount: 3 }] },
      });
      requestMock.mockResolvedValueOnce({ removeClimbFromPlaylist: false });

      const { queryClient, Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists.length).toBe(1));

      await act(async () => {
        await result.current.playlistsProviderProps.removeFromPlaylist('p-1', 'climb-x');
      });

      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])?.[0].climbCount).toBe(3);
    });

    // A server that predates `wasAlreadyInPlaylist` (or a bundle whose
    // selection set omits it) returns undefined; keep the pre-#4014 +1.
    it('still bumps climbCount when the response omits wasAlreadyInPlaylist', async () => {
      requestMock.mockResolvedValueOnce({
        allUserPlaylists: { playlists: [{ ...mkPlaylist('p-1', 'Hard sends'), climbCount: 1 }] },
      });
      requestMock.mockResolvedValueOnce({ addClimbToPlaylist: {} });

      const { queryClient, Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists.length).toBe(1));

      await act(async () => {
        await result.current.playlistsProviderProps.addToPlaylist('p-1', 'climb-x', 50);
      });

      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])?.[0].climbCount).toBe(2);
    });
  });

  // #4014: the hook used to hand PlaylistsProvider a freshly allocated empty Map
  // every render, busting the provider's `getPlaylistsForClimb` memo (and the
  // context value built on it) on every parent render. Real memberships come
  // from `playlistMembershipStore` / the picker's per-climb query instead.
  describe('playlistsProviderProps stability', () => {
    it('does not pass a playlistMemberships map', async () => {
      requestMock.mockResolvedValue({ allUserPlaylists: { playlists: [] } });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      expect('playlistMemberships' in result.current.playlistsProviderProps).toBe(false);
    });
  });

  describe('createPlaylist', () => {
    it('rejects with a helpful error when no active board is selected', async () => {
      withActiveBoard(null);
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      await expect(result.current.playlistsProviderProps.createPlaylist('Project')).rejects.toThrow(/no active board/);
    });

    it('rejects when the active board has no layoutId (CreatePlaylistInput requires Int!)', async () => {
      withActiveBoard({ ...kilterBoard, layoutId: null } as unknown as UserBoard);
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });

      await expect(result.current.playlistsProviderProps.createPlaylist('Project')).rejects.toThrow(/no layoutId/);
      expect(requestMock).not.toHaveBeenCalledWith(CREATE_PLAYLIST, expect.anything());
    });

    it('sends boardType + layoutId from the active board and returns the new playlist', async () => {
      const created = mkPlaylist('p-new', 'Project');
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });
      requestMock.mockResolvedValueOnce({ createPlaylist: created });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      const out = await result.current.playlistsProviderProps.createPlaylist('Project', 'desc', '#fff', 'icon');
      expect(out).toEqual(created);
      expect(requestMock).toHaveBeenCalledWith(CREATE_PLAYLIST, {
        input: {
          boardType: 'kilter',
          layoutId: 1,
          name: 'Project',
          description: 'desc',
          color: '#fff',
          icon: 'icon',
        },
      });
    });

    it('can create against a supplied board snapshot instead of the live active board', async () => {
      const created = mkPlaylist('p-new', 'Moon Projects');
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [] } });
      requestMock.mockResolvedValueOnce({ createPlaylist: created });

      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      await result.current.playlistsProviderProps.createPlaylist('Moon Projects', undefined, undefined, undefined, {
        boardType: 'moonboard',
        layoutId: 6,
      });

      expect(requestMock).toHaveBeenCalledWith(CREATE_PLAYLIST, {
        input: {
          boardType: 'moonboard',
          layoutId: 6,
          name: 'Moon Projects',
          description: undefined,
          color: undefined,
          icon: undefined,
        },
      });
    });

    it('optimistically prepends the new playlist to the cached list', async () => {
      const existing = mkPlaylist('p-old', 'Stuff');
      const created = mkPlaylist('p-new', 'Project');
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [existing] } });
      requestMock.mockResolvedValueOnce({ createPlaylist: created });

      const { queryClient, Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists).toEqual([existing]));

      await act(async () => {
        await result.current.playlistsProviderProps.createPlaylist('Project');
      });

      // The cached list — same key the query above wrote to — should now lead
      // with the freshly-created playlist without waiting for a refetch.
      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])).toEqual([created, existing]);
    });

    it('does not duplicate the created playlist if it is already cached', async () => {
      const existing = mkPlaylist('p-old', 'Stuff');
      const cachedCreated = mkPlaylist('p-new', 'Draft Project');
      const created = { ...cachedCreated, name: 'Project' };
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [cachedCreated, existing] } });
      requestMock.mockResolvedValueOnce({ createPlaylist: created });

      const { queryClient, Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists).toEqual([cachedCreated, existing]));

      await act(async () => {
        await result.current.playlistsProviderProps.createPlaylist('Project');
      });

      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])).toEqual([created, existing]);
    });

    it('cancels an in-flight playlist fetch before optimistically prepending the created playlist', async () => {
      const created = mkPlaylist('p-new', 'Project');
      requestMock.mockImplementation((document) => {
        if (document === GET_ALL_USER_PLAYLISTS) return new Promise(() => undefined);
        if (document === CREATE_PLAYLIST) return Promise.resolve({ createPlaylist: created });
        return Promise.reject(new Error('Unexpected request'));
      });

      const { queryClient, Wrapper } = makeWrapper();
      const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      await act(async () => {
        await result.current.playlistsProviderProps.createPlaylist('Project');
      });

      expect(cancelSpy).toHaveBeenCalledWith({ queryKey: ['userPlaylists'] });
      expect(queryClient.getQueryData<Playlist[]>(['userPlaylists'])).toEqual([created]);
    });

    it('does not cancel the playlist fetch when playlist creation fails', async () => {
      requestMock.mockImplementation((document) => {
        if (document === GET_ALL_USER_PLAYLISTS) return new Promise(() => undefined);
        if (document === CREATE_PLAYLIST) return Promise.reject(new Error('create failed'));
        return Promise.reject(new Error('Unexpected request'));
      });

      const { queryClient, Wrapper } = makeWrapper();
      const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(requestMock).toHaveBeenCalledWith(GET_ALL_USER_PLAYLISTS, expect.anything()));

      await expect(result.current.playlistsProviderProps.createPlaylist('Project')).rejects.toThrow('create failed');

      expect(cancelSpy).not.toHaveBeenCalled();
    });
  });

  describe('refreshPlaylists', () => {
    it('invalidates the playlists cache so the next read refetches', async () => {
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [mkPlaylist('p-1', 'a')] } });

      const { queryClient, Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists.length).toBe(1));
      const stateBefore = queryClient.getQueryState(['userPlaylists']);
      expect(stateBefore?.isInvalidated).toBe(false);

      await act(async () => {
        // A second response for the invalidation-triggered refetch.
        requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: [mkPlaylist('p-1', 'a')] } });
        await result.current.playlistsProviderProps.refreshPlaylists();
      });

      // After invalidate + refetch, the call count should be 2 (initial + refresh).
      expect(requestMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('cross-user cache leak', () => {
    // This is the behaviour AuthProvider.signOut now enforces via
    // queryClient.clear(). The hook itself doesn't trigger the clear, but if
    // the surrounding flow ever stops calling clear() this test demonstrates
    // exactly the leak that would surface: User A's playlists stay cached
    // under the bare `['userPlaylists']` key with no auth dimension, so the
    // next consumer reading the key from the same QueryClient sees them.
    it('queryClient.clear() removes the cached playlists at the auth boundary', async () => {
      const userAPlaylists = [mkPlaylist('p-a', "User A's")];
      requestMock.mockResolvedValueOnce({ allUserPlaylists: { playlists: userAPlaylists } });

      const { queryClient, Wrapper } = makeWrapper();
      const { result } = renderHook(() => useMobileClimbActionsData(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.playlistsProviderProps.playlists).toEqual(userAPlaylists));
      expect(queryClient.getQueryData(['userPlaylists'])).toEqual(userAPlaylists);

      // Simulate signOut clearing the cache.
      queryClient.clear();
      expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
    });
  });
});
