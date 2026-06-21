import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import { useDiscoverPlaylists } from '../use-discover-playlists';
import { usePinnedPlaylists } from '../use-pinned-playlists';
import type {
  DiscoverablePlaylist,
  DiscoverPlaylistsInput,
  DiscoverPlaylistsQueryResponse,
  Playlist,
} from '@boardsesh/graphql/operations/playlists';

function makeDiscoverable(uuid: string): DiscoverablePlaylist {
  return {
    id: uuid,
    uuid,
    boardType: 'kilter',
    layoutId: 1,
    name: `Playlist ${uuid}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    climbCount: 3,
    creatorId: 'creator-1',
    creatorName: 'Creator One',
    isGeneratedRecommendation: false,
  };
}

function makeDiscoverResponse(uuid: string): DiscoverPlaylistsQueryResponse {
  return {
    discoverPlaylists: { playlists: [makeDiscoverable(uuid)], totalCount: 1, hasMore: false },
  };
}

type PendingDiscoverRequest = {
  input: DiscoverPlaylistsInput;
  resolve: (response: DiscoverPlaylistsQueryResponse) => void;
};

function buildWrapper(adapter: Partial<PlaylistsAdapter>) {
  const fullAdapter: PlaylistsAdapter = {
    executeGraphQL: (async () => {
      throw new Error('executeGraphQL not configured');
    }) as ExecutePlaylistsGraphQL,
    recents: noopRecentsAdapter,
    ...adapter,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlaylistsAdapterProvider value={fullAdapter}>{children}</PlaylistsAdapterProvider>
  );
  return { wrapper };
}

describe('useDiscoverPlaylists (shared)', () => {
  it('fetches the first popular + recent page from the adapter on mount', async () => {
    const executeGraphQL = vi.fn(async () => ({
      discoverPlaylists: { playlists: [makeDiscoverable('p1')], totalCount: 1, hasMore: false },
    })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper({ executeGraphQL });

    const { result } = renderHook(() => useDiscoverPlaylists({}), { wrapper });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Two parallel cursors → one request per stream on the initial load.
    expect(executeGraphQL).toHaveBeenCalledTimes(2);
    expect(result.current.popular).toHaveLength(1);
    expect(result.current.recent).toHaveLength(1);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.hasError).toBe(false);
  });

  it('forwards the generated recommendation filter to both streams', async () => {
    const executeGraphQL = vi.fn(async () => ({
      discoverPlaylists: { playlists: [makeDiscoverable('generated')], totalCount: 1, hasMore: false },
    })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper({ executeGraphQL });

    const { result } = renderHook(
      () =>
        useDiscoverPlaylists({
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 25,
          angle: 40,
          generatedRecommendation: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(executeGraphQL).toHaveBeenCalledTimes(2);
    expect(executeGraphQL).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 25,
          angle: 40,
          generatedRecommendation: true,
          sortBy: 'popular',
        }),
      }),
    );
    expect(executeGraphQL).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          boardType: 'kilter',
          layoutId: 8,
          sizeId: 25,
          angle: 40,
          generatedRecommendation: true,
          sortBy: 'recent',
        }),
      }),
    );
  });

  it('forwards the community playlist filter to both streams', async () => {
    const executeGraphQL = vi.fn(async () => ({
      discoverPlaylists: { playlists: [makeDiscoverable('community')], totalCount: 1, hasMore: false },
    })) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper({ executeGraphQL });

    const { result } = renderHook(() => useDiscoverPlaylists({ generatedRecommendation: false }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(executeGraphQL).toHaveBeenCalledTimes(2);
    expect(executeGraphQL).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({ generatedRecommendation: false, sortBy: 'popular' }),
      }),
    );
    expect(executeGraphQL).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({ generatedRecommendation: false, sortBy: 'recent' }),
      }),
    );
  });

  it('waits to fetch until enabled becomes true', async () => {
    const executeGraphQL = vi.fn(async () => makeDiscoverResponse('enabled')) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper({ executeGraphQL });
    const initialHookProps = { enabled: false };

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDiscoverPlaylists({ enabled, generatedRecommendation: true }),
      { initialProps: initialHookProps, wrapper },
    );

    expect(result.current.isLoading).toBe(false);
    expect(executeGraphQL).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(executeGraphQL).toHaveBeenCalledTimes(2);
    expect(result.current.popular.map((playlist) => playlist.uuid)).toEqual(['enabled']);
    expect(result.current.recent.map((playlist) => playlist.uuid)).toEqual(['enabled']);
  });

  it('lets a filter reset supersede an in-flight initial fetch', async () => {
    const pendingRequests: PendingDiscoverRequest[] = [];
    const executeGraphQL = vi.fn(
      (_query: string, variables: { input: DiscoverPlaylistsInput }) =>
        new Promise<DiscoverPlaylistsQueryResponse>((resolve) => {
          pendingRequests.push({ input: variables.input, resolve });
        }),
    ) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper({ executeGraphQL });
    const initialHookProps: { boardType?: string } = { boardType: undefined };

    const { result, rerender } = renderHook(
      ({ boardType }: { boardType?: string }) =>
        useDiscoverPlaylists({ boardType, layoutId: 8, sizeId: 25, angle: 40, generatedRecommendation: true }),
      { initialProps: initialHookProps, wrapper },
    );

    await waitFor(() => expect(pendingRequests).toHaveLength(2));
    rerender({ boardType: 'kilter' });

    await waitFor(() => expect(pendingRequests).toHaveLength(4));
    expect(pendingRequests[0].input.boardType).toBeUndefined();
    expect(pendingRequests[2].input.boardType).toBe('kilter');

    await act(async () => {
      pendingRequests[0].resolve(makeDiscoverResponse('stale-popular'));
      pendingRequests[1].resolve(makeDiscoverResponse('stale-recent'));
      await Promise.resolve();
    });

    expect(result.current.popular).toEqual([]);
    expect(result.current.recent).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      pendingRequests[2].resolve(makeDiscoverResponse('scoped-popular'));
      pendingRequests[3].resolve(makeDiscoverResponse('scoped-recent'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.popular.map((playlist) => playlist.uuid)).toEqual(['scoped-popular']);
    expect(result.current.recent.map((playlist) => playlist.uuid)).toEqual(['scoped-recent']);
  });

  it('sets hasError when the initial fetch rejects', async () => {
    const executeGraphQL = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as ExecutePlaylistsGraphQL;
    const { wrapper } = buildWrapper({ executeGraphQL });

    const { result } = renderHook(() => useDiscoverPlaylists({}), { wrapper });

    await waitFor(() => expect(result.current.hasError).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it('throws when no PlaylistsAdapterProvider is mounted', () => {
    expect(() => renderHook(() => useDiscoverPlaylists({}))).toThrow(/PlaylistsAdapterProvider/);
  });
});

describe('usePinnedPlaylists (shared)', () => {
  function makePlaylist(uuid: string): Playlist {
    return {
      id: uuid,
      uuid,
      boardType: 'kilter',
      layoutId: 1,
      name: `Playlist ${uuid}`,
      isPublic: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      climbCount: 3,
      followerCount: 0,
      isFollowedByMe: false,
      isPinnedByMe: false,
    };
  }

  it('falls back to recents (intersected with candidates) when nothing is pinned', async () => {
    const executeGraphQL = vi.fn(async () => ({ myPinnedPlaylists: [] })) as unknown as ExecutePlaylistsGraphQL;
    const recents = {
      getRecentPlaylists: vi.fn(async () => [{ uuid: 'p1', boardType: 'kilter', layoutId: 1, timestamp: 1 }]),
    };
    const { wrapper } = buildWrapper({ executeGraphQL, recents });

    const { result } = renderHook(
      () => usePinnedPlaylists({ token: 'tok', candidatePlaylists: [makePlaylist('p1')] }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.source).toBe('recent');
    expect(result.current.pinned).toHaveLength(1);
    expect(result.current.pinned[0]?.uuid).toBe('p1');
  });
});
