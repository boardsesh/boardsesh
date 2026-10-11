import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import { useSmartPlaylist } from '../use-smart-playlist';

describe('smart playlist board-scoped requests', () => {
  it('forwards genuine board geometry and separates board or angle changes in the cache', async () => {
    const execute = vi.fn(async () => ({ smartPlaylist: { climbs: [], hasMore: false, totalCount: 0 } }));
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
    const { result, rerender } = renderHook(
      ({ boardUuid, angle }) =>
        useSmartPlaylist({
          smartPlaylistType: 'PROJECTS',
          userId: 'climber',
          boardName: 'spray',
          boardUuid,
          sizeId: 17,
          angle,
          pageSize: 10,
        }),
      { wrapper, initialProps: { boardUuid: 'liz', angle: 40 } },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(execute).toHaveBeenCalledWith(expect.any(String), {
      input: {
        type: 'PROJECTS',
        userId: 'climber',
        boardName: 'spray',
        boardUuid: 'liz',
        sizeId: 17,
        angle: 40,
        page: 0,
        pageSize: 10,
      },
    });
    rerender({ boardUuid: 'bowlo', angle: 40 });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    rerender({ boardUuid: 'bowlo', angle: 45 });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    client.clear();
  });
});
