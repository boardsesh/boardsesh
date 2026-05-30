// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
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

  it('supplied mutations are invoked when called', async () => {
    const addToPlaylist = vi.fn(async (_playlistId: string, _climbUuid: string, _angle: number) => undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsProvider addToPlaylist={addToPlaylist}>{children}</PlaylistsProvider>
    );
    const { result } = renderHook(() => usePlaylistsContext(), { wrapper });
    await result.current.addToPlaylist('p-1', 'climb-A', 40);
    expect(addToPlaylist).toHaveBeenCalledWith('p-1', 'climb-A', 40);
  });

  it('usePlaylistsContext throws when called outside a provider', () => {
    expect(() => renderHook(() => usePlaylistsContext())).toThrow(/must be used within a PlaylistsProvider/);
  });
});
