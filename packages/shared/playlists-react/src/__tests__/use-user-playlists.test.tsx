import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import { useUserPlaylists } from '../use-user-playlists';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

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
    climbCount: 1,
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
  };
}

type AllUserPlaylistsResponse = {
  allUserPlaylists: { playlists: Playlist[]; totalCount: number; hasMore: boolean };
};

function buildWrapper(executeGraphQL: ExecutePlaylistsGraphQL) {
  const adapter: PlaylistsAdapter = { executeGraphQL, recents: noopRecentsAdapter };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>
  );
  return { wrapper };
}

// The hook deliberately console.errors on a page failure; keep the test output
// clean while still exercising the failure path.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('useUserPlaylists (shared) — background pagination failure', () => {
  it('flags hasLoadMoreError after three failed pages, then retryLoadMore re-arms and clears it on success', async () => {
    let call = 0;
    const executeGraphQL = vi.fn(async (): Promise<AllUserPlaylistsResponse> => {
      call += 1;
      // Page 0 (mount): succeeds, more pages remain.
      if (call === 1) return { allUserPlaylists: { playlists: [makePlaylist('p0')], totalCount: 100, hasMore: true } };
      // Pages 2–4 (three loadMore attempts): fail.
      if (call <= 4) throw new Error('boom');
      // Retry: succeeds, list now exhausted.
      return { allUserPlaylists: { playlists: [makePlaylist('p1')], totalCount: 100, hasMore: false } };
    }) as unknown as ExecutePlaylistsGraphQL;

    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => useUserPlaylists({ token: 'tok' }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.playlists).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.hasLoadMoreError).toBe(false);

    // Three consecutive failures freeze pagination and surface the error.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        result.current.loadMore();
      });
      await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
    }
    expect(result.current.hasLoadMoreError).toBe(true);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.playlists).toHaveLength(1);

    // Manual retry re-arms hasMore, re-fetches the failed page, and clears the error.
    await act(async () => {
      result.current.retryLoadMore();
    });
    await waitFor(() => expect(result.current.hasLoadMoreError).toBe(false));
    expect(result.current.playlists).toHaveLength(2);
    expect(result.current.hasMore).toBe(false);
    expect(executeGraphQL).toHaveBeenCalledTimes(5);
  });

  it('retryLoadMore is a no-op while a fetch is already in flight', async () => {
    let resolveInitial: (() => void) | undefined;
    const executeGraphQL = vi.fn(
      () =>
        new Promise<AllUserPlaylistsResponse>((resolve) => {
          resolveInitial = () => resolve({ allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false } });
        }),
    ) as unknown as ExecutePlaylistsGraphQL;

    const { wrapper } = buildWrapper(executeGraphQL);
    const { result } = renderHook(() => useUserPlaylists({ token: 'tok' }), { wrapper });

    // Initial page is in flight (isFetchingRef is set).
    expect(result.current.isLoading).toBe(true);
    expect(executeGraphQL).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.retryLoadMore();
    });
    // Guarded by isFetchingRef → no second request.
    expect(executeGraphQL).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitial?.();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });
});

describe('useUserPlaylists (shared) — refresh during pagination', () => {
  it.each(['success', 'failure'] as const)(
    'replaces old pages after reconnect while pagination settles with %s',
    async (outcome) => {
      let finishPage: ((response: AllUserPlaylistsResponse) => void) | undefined;
      let failPage: ((error: Error) => void) | undefined;
      const executeGraphQL = vi
        .fn()
        .mockResolvedValueOnce({
          allUserPlaylists: { playlists: [makePlaylist('offline-page-zero')], totalCount: 2, hasMore: true },
        })
        .mockImplementationOnce(
          () =>
            new Promise<AllUserPlaylistsResponse>((resolve, reject) => {
              finishPage = resolve;
              failPage = reject;
            }),
        )
        .mockResolvedValueOnce({
          allUserPlaylists: { playlists: [makePlaylist('server-page-zero')], totalCount: 1, hasMore: false },
        });
      const { wrapper } = buildWrapper(executeGraphQL as ExecutePlaylistsGraphQL);
      const { result } = renderHook(() => useUserPlaylists({ token: 'tok' }), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      act(() => result.current.loadMore());
      expect(executeGraphQL).toHaveBeenCalledTimes(2);

      // Reconnect and returning focus can both request a refresh while the
      // next page is out. One eventual page-zero replacement must win.
      act(() => {
        result.current.refetch();
        result.current.refetch();
      });
      expect(executeGraphQL).toHaveBeenCalledTimes(2);

      await act(async () => {
        if (outcome === 'failure') failPage?.(new Error('connection lost during pagination'));
        else {
          finishPage?.({
            allUserPlaylists: { playlists: [makePlaylist('server-page-one')], totalCount: 2, hasMore: false },
          });
        }
      });
      await waitFor(() =>
        expect(result.current.playlists.map((playlist) => playlist.uuid)).toEqual(['server-page-zero']),
      );
      expect(executeGraphQL).toHaveBeenCalledTimes(3);
      expect(executeGraphQL.mock.calls[2]?.[1]).toMatchObject({ input: { page: 0 } });
      expect(result.current.hasMore).toBe(false);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isLoadingMore).toBe(false);
      expect(result.current.hasError).toBe(false);
      expect(result.current.hasLoadMoreError).toBe(false);
    },
  );
});
