import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import { usePlaylistClimbs } from '../use-playlist-climbs';

describe('usePlaylistClimbs', () => {
  it('reads local membership without GraphQL even when an account transport remains available', async () => {
    const executeGraphQL = vi.fn() as unknown as ExecutePlaylistsGraphQL;
    const listClimbs = vi.fn(async () => ({
      climbs: [
        {
          uuid: 'climb-1',
          boardType: 'kilter',
          layoutId: 1,
          setter_username: 'setter',
          name: 'Local climb',
          description: '',
          frames: 'frames',
          angle: 40,
          ascensionist_count: 0,
          difficulty: 'V4',
          quality_average: '0',
          stars: 0,
          difficulty_error: '0',
          benchmark_difficulty: null,
        },
      ],
      totalCount: 1,
      hasMore: false,
    }));
    const unavailable = async (): Promise<never> => {
      throw new Error('unused');
    };
    const adapter: PlaylistsAdapter = {
      executeGraphQL,
      recents: noopRecentsAdapter,
      localLibrary: {
        list: vi.fn(async () => ({ playlists: [], totalCount: 0, hasMore: false })),
        get: vi.fn(async () => null),
        listClimbs,
        create: unavailable,
        update: unavailable,
        delete: vi.fn(async () => false),
        removeClimb: vi.fn(async () => false),
        reorderClimb: vi.fn(async () => false),
      },
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => usePlaylistClimbs({ playlistUuid: 'playlist-local' }), { wrapper });

    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['climb-1']));
    expect(listClimbs).toHaveBeenCalledWith({ playlistId: 'playlist-local', page: 0, pageSize: 20 });
    expect(executeGraphQL).not.toHaveBeenCalled();
  });
});
