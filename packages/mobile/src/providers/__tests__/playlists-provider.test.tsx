// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

// The provider imports `../lib/analytics`. Replace that module with a spy so we
// can assert the instrumentation fires (the `posthog-react-native` native dep is
// separately stubbed via the vite.config alias). `vi.hoisted` is required: bare
// `vi.mock` factories are hoisted above top-level `const`s, so the spy must be
// created inside a hoisted block to be in scope when the factory runs.
const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

import { PlaylistsProvider, usePlaylistsContext } from '../playlists-provider';

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

describe('PlaylistsProvider', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });

  it('exposes the supplied playlists + isLoading/isAuthenticated flags', () => {
    const playlists = [mkPlaylist('p-1', 'Hard sends'), mkPlaylist('p-2', 'V4 grind')];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider playlists={playlists} isLoading={true} isAuthenticated={true}>
        {children}
      </PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    expect(result.current.playlists).toEqual(playlists);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('getPlaylistsForClimb returns memberships from the prop map', () => {
    const memberships = new Map<string, Set<string>>([['climb-A', new Set(['p-1', 'p-2'])]]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider playlistMemberships={memberships}>{children}</PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    expect([...result.current.getPlaylistsForClimb('climb-A')]).toEqual(['p-1', 'p-2']);
    expect(result.current.getPlaylistsForClimb('climb-B').size).toBe(0);
  });

  it('default addToPlaylist throws a `notWired` error referencing useClimbActionsData', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PlaylistsProvider>{children}</PlaylistsProvider>;
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await expect(result.current.addToPlaylist('p-1', 'climb-A', 40)).rejects.toThrow(/useClimbActionsData/);
  });

  it('default refreshPlaylists also throws a `notWired` error (consistent with mutations)', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PlaylistsProvider>{children}</PlaylistsProvider>;
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await expect(result.current.refreshPlaylists()).rejects.toThrow(/refreshPlaylists.*useClimbActionsData/s);
  });

  it('defaults isLoading to true when not supplied — so [] + loading=false is not mistaken for "user has no playlists"', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <PlaylistsProvider>{children}</PlaylistsProvider>;
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    expect(result.current.playlists).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('supplied mutations are invoked when called and Add to Playlist is tracked once', async () => {
    const addToPlaylist = vi.fn(async (_playlistId: string, _climbUuid: string, _angle: number) => undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider playlists={[mkPlaylist('p-1', 'Hard sends')]} addToPlaylist={addToPlaylist}>
        {children}
      </PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await result.current.addToPlaylist('p-1', 'climb-A', 40);
    expect(addToPlaylist).toHaveBeenCalledWith('p-1', 'climb-A', 40);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Add to Playlist', {
      playlistId: 'p-1',
      climbUuid: 'climb-A',
    });
  });

  it('removeFromPlaylist tracks Remove from Playlist once without user-entered names', async () => {
    const removeFromPlaylist = vi.fn(async (_playlistId: string, _climbUuid: string) => undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider playlists={[mkPlaylist('p-2', 'V4 grind')]} removeFromPlaylist={removeFromPlaylist}>
        {children}
      </PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await result.current.removeFromPlaylist('p-2', 'climb-B');
    expect(removeFromPlaylist).toHaveBeenCalledWith('p-2', 'climb-B');
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Remove from Playlist', {
      playlistId: 'p-2',
      climbUuid: 'climb-B',
    });
  });

  it('add tracking only includes playlist and climb ids when the id is not in the list', async () => {
    const addToPlaylist = vi.fn(async (_playlistId: string, _climbUuid: string, _angle: number) => undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider playlists={[]} addToPlaylist={addToPlaylist}>
        {children}
      </PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await result.current.addToPlaylist('missing', 'climb-A', 40);
    expect(trackMock).toHaveBeenCalledWith('Add to Playlist', {
      playlistId: 'missing',
      climbUuid: 'climb-A',
    });
  });

  it('createPlaylist tracks Create Playlist once without the user-entered name', async () => {
    const createPlaylist = vi.fn(async (name: string) => mkPlaylist('p-new', name));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider createPlaylist={createPlaylist}>{children}</PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await result.current.createPlaylist('Projects');
    expect(createPlaylist).toHaveBeenCalledWith('Projects', undefined, undefined, undefined, undefined);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Create Playlist', {
      playlistId: 'p-new',
      hasDescription: false,
      hasColor: false,
      hasIcon: false,
    });
  });

  it('forwards board context when createPlaylist receives one', async () => {
    const createPlaylist = vi.fn(async (name: string) => mkPlaylist('p-board', name));
    const boardContext = { boardType: 'kilter' as const, layoutId: 1 };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider createPlaylist={createPlaylist}>{children}</PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await result.current.createPlaylist('Projects', 'Moon projects', '#ff00ff', 'star', boardContext);
    expect(createPlaylist).toHaveBeenCalledWith('Projects', 'Moon projects', '#ff00ff', 'star', boardContext);
  });

  it('usePlaylistsContext throws when called outside a provider', () => {
    expect(() => renderHook(() => usePlaylistsContext())).toThrow(/must be used within a PlaylistsProvider/);
  });
});
