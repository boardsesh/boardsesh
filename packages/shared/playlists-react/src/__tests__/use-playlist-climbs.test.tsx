import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GetPlaylistClimbsInput } from '@boardsesh/graphql/operations/playlists';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import {
  keepPreviousViewResults,
  playlistClimbsGeometryKey,
  playlistClimbsQueryKey,
  playlistClimbsQueryKeyFor,
  usePlaylistClimbs,
  type PlaylistClimbsView,
} from '../use-playlist-climbs';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function climbPage(uuids: string[]) {
  return {
    playlistClimbs: {
      climbs: uuids.map((uuid) => ({ uuid, name: uuid })),
      totalCount: uuids.length,
      hasMore: false,
    },
  };
}

/** The `input` variable of the `call`-th request the hook sent. */
function sentInput(execute: ReturnType<typeof vi.fn>, call: number): GetPlaylistClimbsInput | undefined {
  const variables = (execute.mock.calls[call] as unknown[] | undefined)?.[1] as
    | { input: GetPlaylistClimbsInput }
    | undefined;
  return variables?.input;
}

function renderWithAdapter(execute: ReturnType<typeof vi.fn>) {
  const adapter: PlaylistsAdapter = {
    executeGraphQL: execute as unknown as ExecutePlaylistsGraphQL,
    recents: noopRecentsAdapter,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

describe('usePlaylistClimbs', () => {
  it('sends no view field for the default view, so the request is the one sent before views', async () => {
    const execute = vi.fn(async () => climbPage(['a']));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result } = renderHook(() => usePlaylistClimbs({ playlistUuid: 'p-1', pageSize: 10 }), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(execute).toHaveBeenCalledWith(expect.any(String), {
      input: { playlistId: 'p-1', page: 0, pageSize: 10 },
    });
    expect(Object.keys(sentInput(execute, 0) ?? {})).not.toContain('view');
    client.clear();
  });

  it('keys each view after the playlist uuid, so a playlist-wide invalidation clears every view', async () => {
    const execute = vi.fn(async () => climbPage(['a']));
    const { client, wrapper } = renderWithAdapter(execute);
    const view: PlaylistClimbsView = { sortBy: 'difficulty', sortOrder: 'asc' };
    const { result } = renderHook(() => usePlaylistClimbs({ playlistUuid: 'p-1', view }), { wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(sentInput(execute, 0)?.view).toEqual(view);

    const cachedKeys = client
      .getQueryCache()
      .findAll({ queryKey: ['playlistClimbs', 'p-1'] })
      .map((query) => query.queryKey);
    expect(cachedKeys).toEqual([['playlistClimbs', 'p-1', 'all', null, null, view, 0]]);
    client.clear();
  });

  it('builds the same key the hook caches under, so one view can be invalidated on its own', async () => {
    const execute = vi.fn(async () => climbPage(['a']));
    const { client, wrapper } = renderWithAdapter(execute);
    const view: PlaylistClimbsView = { sortBy: 'name', sortOrder: 'asc' };
    const { result } = renderHook(
      () =>
        usePlaylistClimbs({
          playlistUuid: 'p-1',
          boardUuid: 'board-1',
          boardInput: { activeBoardName: 'kilter', activeAngle: 40 },
          view,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    const key = playlistClimbsQueryKey({ playlistUuid: 'p-1', boardUuid: 'board-1', angle: 40, view: { ...view } });
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeDefined();
    expect(playlistClimbsQueryKey({ playlistUuid: 'p-1' })).toEqual([
      'playlistClimbs',
      'p-1',
      'all',
      null,
      null,
      'default',
      0,
    ]);
    client.clear();
  });

  it('keeps the previous view on screen while the next view loads, and shows the new rows when they land', async () => {
    const nextPage = deferred<ReturnType<typeof climbPage>>();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(climbPage(['playlist-order']))
      .mockReturnValueOnce(nextPage.promise);
    const { client, wrapper } = renderWithAdapter(execute);
    const { result, rerender } = renderHook(
      ({ view }: { view?: PlaylistClimbsView }) => usePlaylistClimbs({ playlistUuid: 'p-1', view }),
      { wrapper, initialProps: {} },
    );
    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['playlist-order']));

    rerender({ view: { sortBy: 'random', sortOrder: 'asc', sortSeed: '7' } });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(result.current.query.isPlaceholderData).toBe(true);
    expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['playlist-order']);

    nextPage.resolve(climbPage(['shuffled']));
    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['shuffled']));
    client.clear();
  });
});

describe('keepPreviousViewResults', () => {
  const GEOMETRY = 'kilter|1|10|1,20';
  const current = ['playlistClimbs', 'p-1', 'all', 40, GEOMETRY, { sortBy: 'name' }, 0];

  it('keeps rows when only the view changed', () => {
    expect(keepPreviousViewResults(current, 'rows', ['playlistClimbs', 'p-1', 'all', 40, GEOMETRY, 'default', 0])).toBe(
      'rows',
    );
  });

  it('keeps rows across a view turning on or off, where only one request sends the geometry', () => {
    expect(keepPreviousViewResults(current, 'rows', ['playlistClimbs', 'p-1', 'all', 40, null, 'default', 0])).toBe(
      'rows',
    );
  });

  it('drops rows from another playlist, board, angle, geometry or refresh', () => {
    for (const previous of [
      ['playlistClimbs', 'p-2', 'all', 40, GEOMETRY, 'default', 0],
      ['playlistClimbs', 'p-1', 'board-2', 40, GEOMETRY, 'default', 0],
      ['playlistClimbs', 'p-1', 'all', 45, GEOMETRY, 'default', 0],
      ['playlistClimbs', 'p-1', 'all', 40, 'kilter|1|12|1,20', 'default', 0],
      ['playlistClimbs', 'p-1', 'all', 40, GEOMETRY, 'default', 1],
      ['smartPlaylist', 'p-1', 'all', 40, GEOMETRY, 'default', 0],
    ]) {
      expect(keepPreviousViewResults(current, 'rows', previous)).toBeUndefined();
    }
  });
});

describe('playlist climbs board geometry', () => {
  it('keys the geometry a request sends, in either board mode, and none for a plain request', () => {
    expect(playlistClimbsGeometryKey(undefined)).toBeNull();
    expect(playlistClimbsGeometryKey({ activeBoardName: 'kilter', activeAngle: 40 })).toBeNull();
    expect(
      playlistClimbsGeometryKey({
        activeBoardName: 'kilter',
        activeAngle: 40,
        activeLayoutId: 1,
        activeSizeId: 10,
        activeSetIds: '1,20',
      }),
    ).toBe('kilter|1|10|1,20');
    expect(playlistClimbsGeometryKey({ boardName: 'tension', layoutId: 9, sizeId: 1, setIds: '8,9', angle: 40 })).toBe(
      'tension|9|1|8,9',
    );
  });

  it('refetches, with no stale rows, when the active board keeps its uuid but changes size, and sends the same body', async () => {
    const nextPage = deferred<ReturnType<typeof climbPage>>();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(climbPage(['fits-10x10']))
      .mockReturnValueOnce(nextPage.promise);
    const { client, wrapper } = renderWithAdapter(execute);
    const view: PlaylistClimbsView = { sortBy: 'position', sortOrder: 'asc', onlyActiveBoard: true };
    const boardInputFor = (sizeId: number) => ({
      activeBoardName: 'kilter',
      activeAngle: 40,
      activeLayoutId: 1,
      activeSizeId: sizeId,
      activeSetIds: '1,20',
    });
    const { result, rerender } = renderHook(
      ({ sizeId }: { sizeId: number }) =>
        usePlaylistClimbs({ playlistUuid: 'p-1', boardUuid: 'board-1', boardInput: boardInputFor(sizeId), view }),
      { wrapper, initialProps: { sizeId: 10 } },
    );
    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['fits-10x10']));

    rerender({ sizeId: 12 });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(result.current.query.isPlaceholderData).toBe(false);
    expect(result.current.allClimbs).toEqual([]);
    expect(sentInput(execute, 1)).toEqual({ playlistId: 'p-1', page: 0, pageSize: 20, ...boardInputFor(12), view });

    nextPage.resolve(climbPage(['fits-12x12']));
    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['fits-12x12']));
    expect(
      client.getQueryCache().find({
        queryKey: playlistClimbsQueryKeyFor({
          playlistUuid: 'p-1',
          boardUuid: 'board-1',
          boardInput: boardInputFor(12),
          view,
        }),
        exact: true,
      }),
    ).toBeDefined();
    client.clear();
  });
});
