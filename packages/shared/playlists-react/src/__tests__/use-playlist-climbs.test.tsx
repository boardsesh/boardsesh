import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GetPlaylistClimbsInput } from '@boardsesh/graphql/operations/playlists';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import { keepPreviousViewResults, usePlaylistClimbs, type PlaylistClimbsView } from '../use-playlist-climbs';

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
    expect(cachedKeys).toEqual([['playlistClimbs', 'p-1', 'all', null, view, 0]]);
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
  const current = ['playlistClimbs', 'p-1', 'all', 40, { sortBy: 'name' }, 0];

  it('keeps rows when only the view changed', () => {
    expect(keepPreviousViewResults(current, 'rows', ['playlistClimbs', 'p-1', 'all', 40, 'default', 0])).toBe('rows');
  });

  it('drops rows from another playlist, board, angle or refresh', () => {
    for (const previous of [
      ['playlistClimbs', 'p-2', 'all', 40, 'default', 0],
      ['playlistClimbs', 'p-1', 'board-2', 40, 'default', 0],
      ['playlistClimbs', 'p-1', 'all', 45, 'default', 0],
      ['playlistClimbs', 'p-1', 'all', 40, 'default', 1],
      ['smartPlaylist', 'p-1', 'all', 40, 'default', 0],
    ]) {
      expect(keepPreviousViewResults(current, 'rows', previous)).toBeUndefined();
    }
  });
});
