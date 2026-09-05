import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import { usePlaylistMutations } from '../use-playlist-mutations';
import {
  CREATE_PLAYLIST,
  UPDATE_PLAYLIST,
  DELETE_PLAYLIST,
  PIN_PLAYLIST,
  UNPIN_PLAYLIST,
  FOLLOW_PLAYLIST,
  UNFOLLOW_PLAYLIST,
  type Playlist,
} from '@boardsesh/graphql/operations/playlists';

function makePlaylist(uuid: string): Playlist {
  return {
    id: uuid,
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    name: `Playlist ${uuid}`,
    isPublic: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    climbCount: 0,
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
  };
}

function buildWrapper(executeGraphQL: ExecutePlaylistsGraphQL) {
  const fullAdapter: PlaylistsAdapter = { executeGraphQL, recents: noopRecentsAdapter };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlaylistsAdapterProvider value={fullAdapter}>{children}</PlaylistsAdapterProvider>
  );
  return { wrapper };
}

describe('usePlaylistMutations (shared)', () => {
  it('createPlaylist sends CREATE_PLAYLIST with the input and returns the new playlist', async () => {
    const created = makePlaylist('new');
    const executeGraphQL = vi.fn(async () => ({ createPlaylist: created })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistMutations(), { wrapper });

    const input = { boardType: 'kilter', layoutId: 1, name: 'New' };
    const out = await result.current.createPlaylist(input);

    expect(executeGraphQL).toHaveBeenCalledWith(CREATE_PLAYLIST, { input });
    expect(out).toBe(created);
  });

  it('updatePlaylist sends UPDATE_PLAYLIST with the input and returns the updated playlist', async () => {
    const updated = makePlaylist('p1');
    const executeGraphQL = vi.fn(async () => ({ updatePlaylist: updated })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistMutations(), { wrapper });

    const input = { playlistId: 'p1', name: 'Renamed', isPublic: true };
    const out = await result.current.updatePlaylist(input);

    expect(executeGraphQL).toHaveBeenCalledWith(UPDATE_PLAYLIST, { input });
    expect(out).toBe(updated);
  });

  it('deletePlaylist sends DELETE_PLAYLIST with the id and returns the boolean', async () => {
    const executeGraphQL = vi.fn(async () => ({ deletePlaylist: true })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistMutations(), { wrapper });

    const out = await result.current.deletePlaylist('p1');

    expect(executeGraphQL).toHaveBeenCalledWith(DELETE_PLAYLIST, { playlistId: 'p1' });
    expect(out).toBe(true);
  });

  it('pin/unpin send the {input:{playlistUuid}} shape and return the boolean', async () => {
    const executeGraphQL = vi.fn(async (query: string) =>
      query === PIN_PLAYLIST ? { pinPlaylist: true } : { unpinPlaylist: true },
    ) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistMutations(), { wrapper });

    await expect(result.current.pinPlaylist('p1')).resolves.toBe(true);
    expect(executeGraphQL).toHaveBeenCalledWith(PIN_PLAYLIST, { input: { playlistUuid: 'p1' } });

    await expect(result.current.unpinPlaylist('p1')).resolves.toBe(true);
    expect(executeGraphQL).toHaveBeenCalledWith(UNPIN_PLAYLIST, { input: { playlistUuid: 'p1' } });
  });

  it('follow/unfollow send the {input:{playlistUuid}} shape and return the boolean', async () => {
    const executeGraphQL = vi.fn(async (query: string) =>
      query === FOLLOW_PLAYLIST ? { followPlaylist: true } : { unfollowPlaylist: true },
    ) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => usePlaylistMutations(), { wrapper });

    await expect(result.current.followPlaylist('p1')).resolves.toBe(true);
    expect(executeGraphQL).toHaveBeenCalledWith(FOLLOW_PLAYLIST, { input: { playlistUuid: 'p1' } });

    await expect(result.current.unfollowPlaylist('p1')).resolves.toBe(true);
    expect(executeGraphQL).toHaveBeenCalledWith(UNFOLLOW_PLAYLIST, { input: { playlistUuid: 'p1' } });
  });

  it('prefers the explicit executeGraphQL option over the adapter', async () => {
    const adapterExec = vi.fn(async () => ({ deletePlaylist: false })) as unknown as ExecutePlaylistsGraphQL;
    const override = vi.fn(async () => ({ deletePlaylist: true })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper(adapterExec);
    const { result } = renderHook(() => usePlaylistMutations({ executeGraphQL: override }), { wrapper });

    await expect(result.current.deletePlaylist('p1')).resolves.toBe(true);
    expect(override).toHaveBeenCalledTimes(1);
    expect(adapterExec).not.toHaveBeenCalled();
  });

  it('uses local create/update/delete overrides without GraphQL', async () => {
    const created = makePlaylist('local');
    const executeGraphQL = vi.fn() as unknown as ExecutePlaylistsGraphQL;
    const localLibrary = {
      list: vi.fn(async () => ({ playlists: [created], totalCount: 1, hasMore: false })),
      get: vi.fn(async () => created),
      listClimbs: vi.fn(async () => ({ climbs: [], totalCount: 0, hasMore: false })),
      create: vi.fn(async () => created),
      update: vi.fn(async () => created),
      delete: vi.fn(async () => true),
      removeClimb: vi.fn(async () => true),
      reorderClimb: vi.fn(async () => true),
    };
    const adapter: PlaylistsAdapter = { executeGraphQL, recents: noopRecentsAdapter, localLibrary };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>
    );
    const { result } = renderHook(() => usePlaylistMutations(), { wrapper });

    await expect(result.current.createPlaylist({ boardType: 'kilter', layoutId: 1, name: 'Local' })).resolves.toBe(
      created,
    );
    await expect(result.current.updatePlaylist({ playlistId: 'local', name: 'Renamed' })).resolves.toBe(created);
    await expect(result.current.deletePlaylist('local')).resolves.toBe(true);
    expect(executeGraphQL).not.toHaveBeenCalled();
  });

  it('throws when no PlaylistsAdapterProvider is mounted', () => {
    expect(() => renderHook(() => usePlaylistMutations())).toThrow(/PlaylistsAdapterProvider/);
  });
});
