import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useClimbActionsData } from '../use-climb-actions-data';
import { createQueryWrapper } from '@/app/test-utils/test-providers';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: vi.fn(),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations/favorites', () => ({
  GET_FAVORITES: 'GET_FAVORITES',
  TOGGLE_FAVORITE: 'TOGGLE_FAVORITE',
}));

vi.mock('@boardsesh/graphql/operations/playlists', () => ({
  GET_ALL_USER_PLAYLISTS: 'GET_ALL_USER_PLAYLISTS',
  GET_PLAYLISTS_FOR_CLIMBS: 'GET_PLAYLISTS_FOR_CLIMBS',
  ADD_CLIMB_TO_PLAYLIST: 'ADD_CLIMB_TO_PLAYLIST',
  REMOVE_CLIMB_FROM_PLAYLIST: 'REMOVE_CLIMB_FROM_PLAYLIST',
  CREATE_PLAYLIST: 'CREATE_PLAYLIST',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSnackbar = vi.mocked(useSnackbar);

const defaultOptions = {
  boardName: 'kilter',
  layoutId: 1,
  angle: 40,
  climbUuids: ['climb-1', 'climb-2'],
};

describe('useClimbActionsData', () => {
  const mockShowMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    mockUseSnackbar.mockReturnValue({ showMessage: mockShowMessage });
    mockRequest.mockReset();
  });

  it('returns favorites set from GraphQL response', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: ['climb-1'] });
    // Playlists queries
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.favorites.has('climb-1')).toBe(true);
    });

    expect(mockRequest).toHaveBeenCalledWith('GET_FAVORITES', {
      climbUuids: ['climb-1', 'climb-2'],
    });
  });

  it('disabled when not authenticated', () => {
    mockUseWsAuthToken.mockReturnValue({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    // Should not fire any requests when not authenticated
    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.favoritesProviderProps.isAuthenticated).toBe(false);
  });

  it('disabled when climbUuids empty', () => {
    const wrapper = createQueryWrapper();
    renderHook(() => useClimbActionsData({ ...defaultOptions, climbUuids: [] }), { wrapper });

    // With empty climbUuids, favorites query should not be enabled
    // Only the playlists query (which doesn't depend on climbUuids) might fire
    expect(mockRequest).not.toHaveBeenCalledWith('GET_FAVORITES', expect.anything());
  });

  it('isFavorited returns true for favorited climb', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: ['climb-2'] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.favorites.has('climb-2')).toBe(true);
      expect(result.current.favoritesProviderProps.favorites.has('climb-1')).toBe(false);
    });
  });

  it('toggleFavorite sends mutation and returns result', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    // Wait for initial queries
    await waitFor(() => {
      expect(result.current.favoritesProviderProps.isLoading).toBe(false);
    });

    // Mock the toggle mutation response
    mockRequest.mockResolvedValueOnce({
      toggleFavorite: { favorited: true },
    });

    let toggleResult: boolean | undefined;
    await act(async () => {
      toggleResult = await result.current.favoritesProviderProps.toggleFavorite('climb-1');
    });

    expect(toggleResult).toBe(true);
    expect(mockRequest).toHaveBeenCalledWith('TOGGLE_FAVORITE', {
      input: { climbUuid: 'climb-1' },
    });
  });

  it('optimistic update: adds uuid on toggle', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.isLoading).toBe(false);
    });

    // Create a promise we can control to keep mutation pending
    let resolveMutation: (value: unknown) => void;
    mockRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );

    // Start the toggle - optimistic update should happen immediately
    let togglePromise: Promise<boolean>;
    act(() => {
      togglePromise = result.current.favoritesProviderProps.toggleFavorite('climb-1');
    });

    // Optimistic update should show climb-1 as favorited
    await waitFor(() => {
      expect(result.current.favoritesProviderProps.favorites.has('climb-1')).toBe(true);
    });

    // Resolve the mutation
    await act(async () => {
      resolveMutation!({ toggleFavorite: { favorited: true } });
      await togglePromise!;
    });
  });

  it('rolls back on toggleFavorite error', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: ['climb-1'] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.favorites.has('climb-1')).toBe(true);
    });

    // Mock the toggle mutation to fail
    mockRequest.mockRejectedValueOnce(new Error('Toggle failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      try {
        await result.current.favoritesProviderProps.toggleFavorite('climb-1');
      } catch {
        // Expected to throw
      }
    });

    // Should roll back to original state
    await waitFor(() => {
      expect(result.current.favoritesProviderProps.favorites.has('climb-1')).toBe(true);
    });

    vi.restoreAllMocks();
  });

  it('shows error snackbar on toggle failure', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.isLoading).toBe(false);
    });

    mockRequest.mockRejectedValueOnce(new Error('Toggle failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      try {
        await result.current.favoritesProviderProps.toggleFavorite('climb-1');
      } catch {
        // Expected
      }
    });

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Failed to update favorite. Please try again.', 'error');
    });

    vi.restoreAllMocks();
  });

  it('returns playlists from GraphQL response', async () => {
    const playlists = [
      { uuid: 'pl-1', name: 'My Playlist', climbCount: 3 },
      { uuid: 'pl-2', name: 'Other Playlist', climbCount: 7 },
    ];
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: { playlists, totalCount: playlists.length, hasMore: false },
    });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.playlists).toEqual(playlists);
    });
  });

  it('addToPlaylist sends mutation and updates accumulated cache', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: {
        playlists: [{ uuid: 'pl-1', name: 'Test', climbCount: 2 }],
        totalCount: 1,
        hasMore: false,
      },
    });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.isLoading).toBe(false);
    });

    // Mock the add mutation
    mockRequest.mockResolvedValueOnce({ addClimbToPlaylist: { success: true } });

    await act(async () => {
      await result.current.playlistsProviderProps.addToPlaylist('pl-1', 'climb-1', 40);
    });

    // Membership should be updated via accumulated cache
    await waitFor(() => {
      expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1')).toBe(true);
    });
  });

  it('removeFromPlaylist sends mutation and updates accumulated cache', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: {
        playlists: [{ uuid: 'pl-1', name: 'Test', climbCount: 5 }],
        totalCount: 1,
        hasMore: false,
      },
    });
    mockRequest.mockResolvedValueOnce({
      playlistsForClimbs: [{ climbUuid: 'climb-1', playlistUuids: ['pl-1'] }],
    });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1')).toBe(true);
    });

    // Now remove
    mockRequest.mockResolvedValueOnce({ removeClimbFromPlaylist: { success: true } });
    await act(async () => {
      await result.current.playlistsProviderProps.removeFromPlaylist('pl-1', 'climb-1');
    });

    // Membership should be removed via accumulated cache
    await waitFor(() => {
      const memberships = result.current.playlistsProviderProps.playlistMemberships.get('climb-1');
      expect(memberships?.has('pl-1')).toBe(false);
    });
  });

  it('rapid addToPlaylist taps converge to a single climbCount increment (#1851)', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: {
        playlists: [{ uuid: 'pl-1', name: 'Test', climbCount: 2 }],
        totalCount: 1,
        hasMore: false,
      },
    });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.isLoading).toBe(false);
    });

    // Three rapid taps — server is idempotent so all three resolve successfully.
    mockRequest.mockResolvedValue({ addClimbToPlaylist: { success: true } });

    await act(async () => {
      await Promise.all([
        result.current.playlistsProviderProps.addToPlaylist('pl-1', 'climb-1', 40),
        result.current.playlistsProviderProps.addToPlaylist('pl-1', 'climb-1', 40),
        result.current.playlistsProviderProps.addToPlaylist('pl-1', 'climb-1', 40),
      ]);
    });

    // Starting count is 2; only the first tap performs an effective add (2 + 1 = 3).
    // Without the membership gate, all three taps would each apply +1 (2 + 3 = 5).
    const addedPlaylist = result.current.playlistsProviderProps.playlists.find((p) => p.uuid === 'pl-1');
    expect(addedPlaylist?.climbCount).toBe(3);
    expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1')).toBe(true);
  });

  it('rapid removeFromPlaylist taps converge to a single climbCount decrement (#1851)', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: {
        playlists: [{ uuid: 'pl-1', name: 'Test', climbCount: 5 }],
        totalCount: 1,
        hasMore: false,
      },
    });
    mockRequest.mockResolvedValueOnce({
      playlistsForClimbs: [{ climbUuid: 'climb-1', playlistUuids: ['pl-1'] }],
    });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1')).toBe(true);
    });

    mockRequest.mockResolvedValue({ removeClimbFromPlaylist: { success: true } });

    await act(async () => {
      await Promise.all([
        result.current.playlistsProviderProps.removeFromPlaylist('pl-1', 'climb-1'),
        result.current.playlistsProviderProps.removeFromPlaylist('pl-1', 'climb-1'),
        result.current.playlistsProviderProps.removeFromPlaylist('pl-1', 'climb-1'),
      ]);
    });

    // Starting count is 5; only the first tap performs an effective remove (5 - 1 = 4).
    // Without the membership gate, all three taps would each apply -1 (5 - 3 = 2).
    const removedPlaylist = result.current.playlistsProviderProps.playlists.find((p) => p.uuid === 'pl-1');
    expect(removedPlaylist?.climbCount).toBe(4);
    expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1')).toBe(false);
  });

  it('addToPlaylist rolls back membership and climbCount when the request fails', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: {
        playlists: [{ uuid: 'pl-1', name: 'Test', climbCount: 2 }],
        totalCount: 1,
        hasMore: false,
      },
    });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.isLoading).toBe(false);
    });

    mockRequest.mockRejectedValueOnce(new Error('network down'));

    await act(async () => {
      await expect(result.current.playlistsProviderProps.addToPlaylist('pl-1', 'climb-1', 40)).rejects.toThrow(
        'network down',
      );
    });

    const playlist = result.current.playlistsProviderProps.playlists.find((p) => p.uuid === 'pl-1');
    expect(playlist?.climbCount).toBe(2);
    expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1') ?? false).toBe(false);
  });

  it('removeFromPlaylist rolls back membership and climbCount when the request fails', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: {
        playlists: [{ uuid: 'pl-1', name: 'Test', climbCount: 5 }],
        totalCount: 1,
        hasMore: false,
      },
    });
    mockRequest.mockResolvedValueOnce({
      playlistsForClimbs: [{ climbUuid: 'climb-1', playlistUuids: ['pl-1'] }],
    });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1')).toBe(true);
    });

    mockRequest.mockRejectedValueOnce(new Error('network down'));

    await act(async () => {
      await expect(result.current.playlistsProviderProps.removeFromPlaylist('pl-1', 'climb-1')).rejects.toThrow(
        'network down',
      );
    });

    const playlist = result.current.playlistsProviderProps.playlists.find((p) => p.uuid === 'pl-1');
    expect(playlist?.climbCount).toBe(5);
    expect(result.current.playlistsProviderProps.playlistMemberships.get('climb-1')?.has('pl-1')).toBe(true);
  });

  it('createPlaylist sends mutation and updates cache', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.isLoading).toBe(false);
    });

    const newPlaylist = { uuid: 'pl-new', name: 'New Playlist', climbCount: 0 };
    mockRequest.mockResolvedValueOnce({ createPlaylist: newPlaylist });

    let created: Playlist | undefined;
    await act(async () => {
      created = await result.current.playlistsProviderProps.createPlaylist('New Playlist');
    });

    expect(created).toEqual(newPlaylist);

    // The new playlist should appear in the playlists list
    await waitFor(() => {
      expect(result.current.playlistsProviderProps.playlists).toContainEqual(newPlaylist);
    });
  });

  it('refreshPlaylists invalidates query', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result } = renderHook(() => useClimbActionsData(defaultOptions), { wrapper });

    await waitFor(() => {
      expect(result.current.playlistsProviderProps.isLoading).toBe(false);
    });

    // Mock the re-fetch after invalidation
    mockRequest.mockResolvedValueOnce({
      allUserPlaylists: {
        playlists: [{ uuid: 'pl-refreshed', name: 'Refreshed', climbCount: 0 }],
        totalCount: 1,
        hasMore: false,
      },
    });

    await act(async () => {
      await result.current.playlistsProviderProps.refreshPlaylists();
    });

    // The query should have been refetched
    await waitFor(() => {
      const lastCallArgs = mockRequest.mock.calls;
      const hasRefetchCall = lastCallArgs.some((call: unknown[]) => call[0] === 'GET_ALL_USER_PLAYLISTS');
      expect(hasRefetchCall).toBe(true);
    });
  });

  it('only fetches new UUIDs incrementally', async () => {
    // Initial fetch for climb-1 and climb-2
    mockRequest.mockResolvedValueOnce({ favorites: ['climb-1'] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();
    const { result, rerender } = renderHook((props) => useClimbActionsData(props), {
      wrapper,
      initialProps: defaultOptions,
    });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.favorites.has('climb-1')).toBe(true);
    });

    // Add climb-3 — only climb-3 should be fetched, not climb-1 and climb-2 again
    mockRequest.mockResolvedValueOnce({ favorites: ['climb-3'] });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    rerender({ ...defaultOptions, climbUuids: ['climb-1', 'climb-2', 'climb-3'] });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.favorites.has('climb-3')).toBe(true);
    });

    // The favorites fetch should only include climb-3 (not climb-1, climb-2)
    const favCalls = mockRequest.mock.calls.filter((call: unknown[]) => call[0] === 'GET_FAVORITES');
    // Second favorites call should only contain the new UUID
    const lastFavCall = favCalls[favCalls.length - 1];
    expect(lastFavCall[1].climbUuids).toEqual(['climb-3']);
    expect(lastFavCall[1]).not.toHaveProperty('boardName');
    expect(lastFavCall[1]).not.toHaveProperty('angle');

    // Original favorites should still be available
    expect(result.current.favoritesProviderProps.favorites.has('climb-1')).toBe(true);
  });

  it('does not refetch when UUIDs are reordered', async () => {
    mockRequest.mockResolvedValueOnce({ favorites: [] });
    mockRequest.mockResolvedValueOnce({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
    mockRequest.mockResolvedValueOnce({ playlistsForClimbs: [] });

    const wrapper = createQueryWrapper();

    // Render with unsorted UUIDs
    const { result, rerender } = renderHook((props) => useClimbActionsData(props), {
      wrapper,
      initialProps: { ...defaultOptions, climbUuids: ['climb-2', 'climb-1'] },
    });

    await waitFor(() => {
      expect(result.current.favoritesProviderProps.isLoading).toBe(false);
    });

    const callCount = mockRequest.mock.calls.length;

    // Rerender with same UUIDs in different order - should NOT trigger new fetch
    rerender({ ...defaultOptions, climbUuids: ['climb-1', 'climb-2'] });

    // Wait a tick to ensure no new requests
    await waitFor(() => {
      // Should not have made additional favorites request since UUIDs are already fetched
      expect(mockRequest.mock.calls.length).toBe(callCount);
    });
  });
});
