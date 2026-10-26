import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { GetMyPinnedPlaylistsQueryResponse, Playlist } from '@boardsesh/graphql/operations/playlists';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter, type RecentPlaylistEntry, type RecentsStorageAdapter } from '../recents-adapter';
import { usePinnedPlaylists, type UsePinnedPlaylistsOptions } from '../use-pinned-playlists';

function deferred<Result>() {
  let resolve: (result: Result) => void = () => {
    throw new Error('Deferred promise not initialized');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('Deferred promise not initialized');
  };
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function playlist(uuid: string): Playlist {
  return {
    id: uuid,
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    name: `Playlist ${uuid}`,
    isPublic: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    climbCount: 3,
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: true,
  };
}

function pinnedResponse(uuid: string): GetMyPinnedPlaylistsQueryResponse {
  return { myPinnedPlaylists: [playlist(uuid)] };
}

function recentEntry(uuid: string): RecentPlaylistEntry {
  return { uuid, boardType: 'kilter', layoutId: 1, timestamp: 1 };
}

function options(overrides: Partial<UsePinnedPlaylistsOptions> = {}): UsePinnedPlaylistsOptions {
  return { token: 'account-a', boardType: 'kilter', layoutId: 1, candidatePlaylists: [], ...overrides };
}

function wrapperFor(executeGraphQL: ExecutePlaylistsGraphQL, recents: RecentsStorageAdapter = noopRecentsAdapter) {
  const adapter: PlaylistsAdapter = { executeGraphQL, recents };
  return function Wrapper({ children }: { children: ReactNode }) {
    return <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>;
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('usePinnedPlaylists request ownership', () => {
  it('does not restore an old account response after sign-out', async () => {
    const oldRequest = deferred<GetMyPinnedPlaylistsQueryResponse>();
    const executeGraphQL = vi.fn().mockReturnValue(oldRequest.promise);
    const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL);
    const { result, rerender } = renderHook((props) => usePinnedPlaylists(props), {
      wrapper,
      initialProps: options(),
    });
    expect(executeGraphQL).toHaveBeenCalledTimes(1);

    rerender(options({ token: null }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => oldRequest.resolve(pinnedResponse('old-private-pin')));

    expect(result.current.pinned).toEqual([]);
    expect(result.current.source).toBe('empty');
    expect(executeGraphQL).toHaveBeenCalledTimes(1);
  });

  it.each(['account', 'board', 'layout', 'transport', 'recents'] as const)(
    'hides the previous scope while the new %s request is pending',
    async (changedInput) => {
      const nextRequest = deferred<GetMyPinnedPlaylistsQueryResponse>();
      const executeGraphQL = vi
        .fn()
        .mockResolvedValueOnce(pinnedResponse('old-pin'))
        .mockReturnValue(nextRequest.promise);
      const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL);
      const { result, rerender } = renderHook((props) => usePinnedPlaylists(props), {
        wrapper,
        initialProps: options(),
      });
      await waitFor(() => expect(result.current.pinned[0]?.uuid).toBe('old-pin'));

      const changedOptions: Partial<UsePinnedPlaylistsOptions> = {};
      if (changedInput === 'account') changedOptions.token = 'account-b';
      if (changedInput === 'board') changedOptions.boardType = 'tension';
      if (changedInput === 'layout') changedOptions.layoutId = 2;
      if (changedInput === 'transport') {
        changedOptions.executeGraphQL = vi.fn().mockReturnValue(nextRequest.promise) as ExecutePlaylistsGraphQL;
      }
      if (changedInput === 'recents') changedOptions.recents = { getRecentPlaylists: async () => [] };
      rerender(options(changedOptions));

      expect(result.current.pinned).toEqual([]);
      expect(result.current.source).toBe('empty');
      expect(result.current.isLoading).toBe(true);
      await act(async () => nextRequest.resolve(pinnedResponse('new-pin')));
      expect(result.current.pinned[0]?.uuid).toBe('new-pin');
      expect(result.current.isLoading).toBe(false);
    },
  );

  it('a retained old refetch cannot take ownership of the new context', async () => {
    const oldRequest = deferred<GetMyPinnedPlaylistsQueryResponse>();
    const nextRequest = deferred<GetMyPinnedPlaylistsQueryResponse>();
    const executeGraphQL = vi.fn().mockReturnValueOnce(oldRequest.promise).mockReturnValue(nextRequest.promise);
    const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL);
    const { result, rerender } = renderHook((props) => usePinnedPlaylists(props), { wrapper, initialProps: options() });
    const oldRefetch = result.current.refetch;

    rerender(options({ token: 'account-b' }));
    act(() => {
      oldRefetch();
    });
    expect(executeGraphQL).toHaveBeenCalledTimes(2);
    await act(async () => nextRequest.resolve(pinnedResponse('new-account-pin')));
    await act(async () => oldRequest.resolve(pinnedResponse('old-account-pin')));

    expect(result.current.pinned[0]?.uuid).toBe('new-account-pin');
    expect(result.current.isLoading).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'a manual refresh settles loading and ignores an older pinned %s',
    async (oldOutcome) => {
      const oldRequest = deferred<GetMyPinnedPlaylistsQueryResponse>();
      const refreshRequest = deferred<GetMyPinnedPlaylistsQueryResponse>();
      const executeGraphQL = vi.fn().mockReturnValueOnce(oldRequest.promise).mockReturnValue(refreshRequest.promise);
      const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL);
      const { result } = renderHook(() => usePinnedPlaylists(options()), { wrapper });
      act(() => {
        result.current.refetch();
      });
      await act(async () => refreshRequest.resolve(pinnedResponse('refreshed-pin')));

      // The superseded first request has not settled, but it no longer owns loading.
      expect(result.current.isLoading).toBe(false);
      await act(async () => {
        if (oldOutcome === 'resolve') oldRequest.resolve(pinnedResponse('stale-pin'));
        else oldRequest.reject(new Error('stale pin failure'));
      });
      expect(result.current.pinned[0]?.uuid).toBe('refreshed-pin');
      expect(result.current.isLoading).toBe(false);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'a recent-playlist notification supersedes an older storage %s',
    async (oldOutcome) => {
      const oldRead = deferred<RecentPlaylistEntry[]>();
      const nextRead = deferred<RecentPlaylistEntry[]>();
      let notify = () => {};
      const recents: RecentsStorageAdapter = {
        getRecentPlaylists: vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValue(nextRead.promise),
        subscribe: (onChange) => {
          notify = onChange;
          return () => {};
        },
      };
      const executeGraphQL = vi.fn().mockResolvedValue({ myPinnedPlaylists: [] });
      const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL, recents);
      const { result } = renderHook(
        () => usePinnedPlaylists(options({ candidatePlaylists: [playlist('old-recent'), playlist('new-recent')] })),
        { wrapper },
      );
      act(() => notify());
      await act(async () => nextRead.resolve([recentEntry('new-recent')]));

      expect(result.current.isLoading).toBe(false);
      expect(result.current.source).toBe('recent');
      await act(async () => {
        if (oldOutcome === 'resolve') oldRead.resolve([recentEntry('old-recent')]);
        else oldRead.reject(new Error('stale storage failure'));
      });
      expect(result.current.pinned[0]?.uuid).toBe('new-recent');
      expect(result.current.isLoading).toBe(false);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it('settles a current recents rejection without losing successful pinned rows', async () => {
    const storageError = new Error('Storage unavailable');
    const recents = { getRecentPlaylists: vi.fn().mockRejectedValue(storageError) };
    const executeGraphQL = vi.fn().mockResolvedValue(pinnedResponse('current-pin'));
    const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL, recents);
    const { result } = renderHook(() => usePinnedPlaylists(options()), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pinned[0]?.uuid).toBe('current-pin');
    expect(result.current.source).toBe('pinned');
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('Failed to fetch recent playlists:', storageError);
  });

  it('keeps the recents fallback when the current pinned request fails', async () => {
    const pinnedError = new Error('Pinned request failed');
    const recents = { getRecentPlaylists: async () => [recentEntry('recent')] };
    const executeGraphQL = vi.fn().mockRejectedValue(pinnedError);
    const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL, recents);
    const { result } = renderHook(() => usePinnedPlaylists(options({ candidatePlaylists: [playlist('recent')] })), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pinned[0]?.uuid).toBe('recent');
    expect(result.current.source).toBe('recent');
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('Failed to fetch pinned playlists:', pinnedError);
  });

  it('ignores pinned and recents failures after unmount', async () => {
    const pinnedRequest = deferred<GetMyPinnedPlaylistsQueryResponse>();
    const recentRead = deferred<RecentPlaylistEntry[]>();
    const executeGraphQL = vi.fn().mockReturnValue(pinnedRequest.promise);
    const wrapper = wrapperFor(executeGraphQL as ExecutePlaylistsGraphQL, {
      getRecentPlaylists: () => recentRead.promise,
    });
    const { unmount } = renderHook(() => usePinnedPlaylists(options()), { wrapper });
    unmount();
    await act(async () => {
      pinnedRequest.reject(new Error('Unmounted pinned request'));
      recentRead.reject(new Error('Unmounted recents read'));
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
