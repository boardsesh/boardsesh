import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import { usePlaylistItemMutations } from '../use-playlist-item-mutations';
import { REORDER_PLAYLIST_CLIMB, REMOVE_CLIMB_FROM_PLAYLIST } from '@boardsesh/graphql/operations/playlists';

function buildWrapper(executeGraphQL: ExecutePlaylistsGraphQL) {
  const fullAdapter: PlaylistsAdapter = { executeGraphQL, recents: noopRecentsAdapter };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlaylistsAdapterProvider value={fullAdapter}>{children}</PlaylistsAdapterProvider>
  );
  return { wrapper };
}

describe('usePlaylistItemMutations (shared)', () => {
  it('reorderPlaylistClimb sends REORDER_PLAYLIST_CLIMB with {input} and returns the boolean', async () => {
    const executeGraphQL = vi.fn(async () => ({ reorderPlaylistClimb: true })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistItemMutations(), { wrapper });

    const input = { playlistId: 'p1', climbUuid: 'c1', newIndex: 2 };
    await expect(result.current.reorderPlaylistClimb(input)).resolves.toBe(true);
    expect(executeGraphQL).toHaveBeenCalledWith(REORDER_PLAYLIST_CLIMB, { input });
  });

  it('removeClimbFromPlaylist sends REMOVE_CLIMB_FROM_PLAYLIST with {input} and returns the boolean', async () => {
    const executeGraphQL = vi.fn(async () => ({ removeClimbFromPlaylist: true })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistItemMutations(), { wrapper });

    const input = { playlistId: 'p1', climbUuid: 'c1' };
    await expect(result.current.removeClimbFromPlaylist(input)).resolves.toBe(true);
    expect(executeGraphQL).toHaveBeenCalledWith(REMOVE_CLIMB_FROM_PLAYLIST, { input });
  });

  it('propagates a rejected executeGraphQL (no error swallowing)', async () => {
    const boom = new Error('network down');
    const executeGraphQL = vi.fn(async () => {
      throw boom;
    }) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistItemMutations(), { wrapper });

    await expect(result.current.reorderPlaylistClimb({ playlistId: 'p1', climbUuid: 'c1', newIndex: 0 })).rejects.toBe(
      boom,
    );
    await expect(result.current.removeClimbFromPlaylist({ playlistId: 'p1', climbUuid: 'c1' })).rejects.toBe(boom);
  });

  it('prefers the explicit executeGraphQL option over the adapter', async () => {
    const adapterExec = vi.fn(async () => ({ reorderPlaylistClimb: false })) as unknown as ExecutePlaylistsGraphQL;
    const override = vi.fn(async () => ({ reorderPlaylistClimb: true })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(adapterExec);
    const { result } = renderHook(() => usePlaylistItemMutations({ executeGraphQL: override }), { wrapper });

    await expect(result.current.reorderPlaylistClimb({ playlistId: 'p1', climbUuid: 'c1', newIndex: 0 })).resolves.toBe(
      true,
    );
    expect(override).toHaveBeenCalledTimes(1);
    expect(adapterExec).not.toHaveBeenCalled();
  });

  it('keeps the returned callbacks stable across re-renders', () => {
    const executeGraphQL = vi.fn(async () => ({ reorderPlaylistClimb: true })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result, rerender } = renderHook(() => usePlaylistItemMutations(), { wrapper });

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.reorderPlaylistClimb).toBe(first.reorderPlaylistClimb);
    expect(result.current.removeClimbFromPlaylist).toBe(first.removeClimbFromPlaylist);
  });

  it('throws when no PlaylistsAdapterProvider is mounted', () => {
    expect(() => renderHook(() => usePlaylistItemMutations())).toThrow(/PlaylistsAdapterProvider/);
  });
});
