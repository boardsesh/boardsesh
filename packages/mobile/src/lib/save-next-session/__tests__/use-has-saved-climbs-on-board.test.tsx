// @vitest-environment jsdom
//
// The gate behind the Climbs "saved climbs" card (#6002): does the ACTIVE board
// have at least one liked climb. The user-wide count would offer saved climbs
// to a climber whose hearts are all on another board.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_SMART_PLAYLIST } from '@boardsesh/graphql/operations/playlists';
import { invalidateKeysForTable } from '@boardsesh/offline-sync';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { HAS_SAVED_CLIMBS_QUERY_KEY, useHasSavedClimbsOnBoard } from '../use-has-saved-climbs-on-board';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function likedPage(climbCount: number) {
  return {
    smartPlaylist: { climbs: Array.from({ length: climbCount }, (_unused, index) => ({ uuid: `climb-${index}` })) },
  };
}

describe('useHasSavedClimbsOnBoard', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('asks for one liked climb on that board type, and says yes when it gets one', async () => {
    requestMock.mockResolvedValue(likedPage(1));
    const { wrapper } = setup();

    const { result } = renderHook(() => useHasSavedClimbsOnBoard({ userId: 'user-1', boardType: 'kilter' }), {
      wrapper,
    });

    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        document: GET_SMART_PLAYLIST,
        variables: { input: { type: 'LIKED_CLIMBS', userId: 'user-1', boardName: 'kilter', page: 0, pageSize: 1 } },
      }),
    );
  });

  it('says no when the board has no liked climb', async () => {
    requestMock.mockResolvedValue(likedPage(0));
    const { wrapper } = setup();

    const { result } = renderHook(() => useHasSavedClimbsOnBoard({ userId: 'user-1', boardType: 'tension' }), {
      wrapper,
    });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
  });

  it('says no when the request fails, so an offline phone shows no card', async () => {
    requestMock.mockRejectedValue(new Error('offline'));
    const { wrapper } = setup();

    const { result } = renderHook(() => useHasSavedClimbsOnBoard({ userId: 'user-1', boardType: 'kilter' }), {
      wrapper,
    });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);
  });

  it.each([
    ['signed out', { userId: null, boardType: 'kilter' }],
    ['no active board', { userId: 'user-1', boardType: null }],
  ])('sends nothing when %s', (_label, options) => {
    const { wrapper } = setup();

    const { result } = renderHook(() => useHasSavedClimbsOnBoard(options), { wrapper });

    expect(result.current).toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('keeps each board and account apart, under one prefix a heart can invalidate', async () => {
    requestMock.mockResolvedValue(likedPage(1));
    const { wrapper, queryClient } = setup();

    const { result } = renderHook(() => useHasSavedClimbsOnBoard({ userId: 'user-1', boardType: 'kilter' }), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toBe(true));

    expect(queryClient.getQueryData([...HAS_SAVED_CLIMBS_QUERY_KEY, 'user-1', 'kilter'])).toBe(true);
    expect(queryClient.getQueryData([...HAS_SAVED_CLIMBS_QUERY_KEY, 'user-1', 'tension'])).toBeUndefined();

    requestMock.mockResolvedValue(likedPage(0));
    await queryClient.invalidateQueries({ queryKey: HAS_SAVED_CLIMBS_QUERY_KEY });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('is refreshed when a queued heart reaches the server', async () => {
    // Every native heart takes the local queue, so the drainer's table map is
    // the only invalidation the card gets on a phone.
    const drainKeys = invalidateKeysForTable('user_favorites') ?? [];
    expect(drainKeys).toContainEqual([...HAS_SAVED_CLIMBS_QUERY_KEY]);

    requestMock.mockResolvedValue(likedPage(0));
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useHasSavedClimbsOnBoard({ userId: 'user-1', boardType: 'kilter' }), {
      wrapper,
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);

    // What the drainer does once the write lands.
    requestMock.mockResolvedValue(likedPage(1));
    await Promise.all(drainKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] })));

    await waitFor(() => expect(result.current).toBe(true));
  });
});
