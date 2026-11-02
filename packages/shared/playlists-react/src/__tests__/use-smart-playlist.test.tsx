import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GetSmartPlaylistInput } from '@boardsesh/graphql/operations/playlists';
import { PlaylistsAdapterProvider, type ExecutePlaylistsGraphQL, type PlaylistsAdapter } from '../adapter';
import { noopRecentsAdapter } from '../recents-adapter';
import type { PlaylistClimbsView } from '../use-playlist-climbs';
import {
  LIKED_LIST_QUERY_KEY_PREFIX,
  MAX_REMEMBERED_UNLIKED_CLIMBS,
  removeClimbFromLikedList,
  restoreClimbToLikedList,
  smartPlaylistGeometryKey,
  smartPlaylistQueryKey,
  useSmartPlaylist,
  type SmartPlaylistActiveBoardInput,
} from '../use-smart-playlist';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function smartPage(uuids: string[]) {
  return {
    smartPlaylist: {
      meta: {
        type: 'LIKED_CLIMBS',
        userId: 'climber',
        userName: 'Climber',
        userAvatar: null,
        climbCount: uuids.length,
      },
      climbs: uuids.map((uuid) => ({ uuid, name: uuid })),
      totalCount: uuids.length,
      unfilteredCount: null,
      hasMore: false,
    },
  };
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

/** The `input` variable of the `call`-th request the hook sent. */
function sentInput(execute: ReturnType<typeof vi.fn>, call: number): GetSmartPlaylistInput | undefined {
  const variables = (execute.mock.calls[call] as unknown[] | undefined)?.[1] as
    | { input: GetSmartPlaylistInput }
    | undefined;
  return variables?.input;
}

const KILTER: SmartPlaylistActiveBoardInput = {
  activeBoardName: 'kilter',
  activeAngle: 40,
  activeLayoutId: 1,
  activeSizeId: 10,
  activeSetIds: '1,20',
};
const HARDEST_FIRST: PlaylistClimbsView = { sortBy: 'difficulty', sortOrder: 'desc' };

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

describe('smart playlist views (#6651)', () => {
  it('sends no view and no active board without a view, so the request is the one sent before views', async () => {
    const execute = vi.fn(async () => smartPage(['a']));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result } = renderHook(
      () => useSmartPlaylist({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'climber', activeBoardInput: KILTER }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(sentInput(execute, 0)).toEqual({ type: 'LIKED_CLIMBS', userId: 'climber', page: 0, pageSize: 20 });
    client.clear();
  });

  it('sends the view with the active board, and keys the view and the board', async () => {
    const execute = vi.fn(async () => smartPage(['a']));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result } = renderHook(
      () =>
        useSmartPlaylist({
          smartPlaylistType: 'LIKED_CLIMBS',
          userId: 'climber',
          view: HARDEST_FIRST,
          activeBoardInput: KILTER,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(sentInput(execute, 0)).toEqual({
      type: 'LIKED_CLIMBS',
      userId: 'climber',
      page: 0,
      pageSize: 20,
      ...KILTER,
      view: HARDEST_FIRST,
    });
    expect(client.getQueryCache().getAll()[0]?.queryKey).toEqual([
      'smartPlaylist',
      'LIKED_CLIMBS',
      'climber',
      'all',
      null,
      null,
      'kilter|40|1|10|1,20',
      HARDEST_FIRST,
    ]);
    client.clear();
  });

  it('keeps one fixed key length, the geometry only with a board and the view last', () => {
    expect(smartPlaylistQueryKey({ smartPlaylistType: 'FIVE_STARS', userId: 'u' })).toEqual([
      'smartPlaylist',
      'FIVE_STARS',
      'u',
      'all',
      null,
      null,
      null,
      'default',
    ]);
    expect(smartPlaylistGeometryKey(undefined)).toBeNull();
    expect(smartPlaylistGeometryKey({ activeBoardName: 'tension', activeAngle: 30 })).toBe('tension|30|||');
  });

  it('keeps the previous rows up while a new view of the same list loads', async () => {
    const nextPage = deferred<ReturnType<typeof smartPage>>();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(smartPage(['newest-like']))
      .mockReturnValueOnce(nextPage.promise);
    const { client, wrapper } = renderWithAdapter(execute);
    const { result, rerender } = renderHook(
      ({ view }: { view?: PlaylistClimbsView }) =>
        useSmartPlaylist({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'climber', view, activeBoardInput: KILTER }),
      { wrapper, initialProps: {} as { view?: PlaylistClimbsView } },
    );
    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['newest-like']));

    rerender({ view: HARDEST_FIRST });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(result.current.query.isPlaceholderData).toBe(true);
    expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['newest-like']);

    nextPage.resolve(smartPage(['hardest']));
    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['hardest']));
    client.clear();
  });

  it('shows nothing stale for another board under a view, or for another list', async () => {
    const nextPage = deferred<ReturnType<typeof smartPage>>();
    const otherList = deferred<ReturnType<typeof smartPage>>();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(smartPage(['on-kilter']))
      .mockReturnValueOnce(nextPage.promise)
      .mockReturnValueOnce(otherList.promise);
    const { client, wrapper } = renderWithAdapter(execute);
    type Props = { activeBoardInput: SmartPlaylistActiveBoardInput; type: 'LIKED_CLIMBS' | 'FIVE_STARS' };
    const { result, rerender } = renderHook(
      ({ activeBoardInput, type }: Props) =>
        useSmartPlaylist({ smartPlaylistType: type, userId: 'climber', view: HARDEST_FIRST, activeBoardInput }),
      { wrapper, initialProps: { activeBoardInput: KILTER, type: 'LIKED_CLIMBS' } as Props },
    );
    await waitFor(() => expect(result.current.allClimbs.map((climb) => climb.uuid)).toEqual(['on-kilter']));

    rerender({ activeBoardInput: { ...KILTER, activeSizeId: 12 }, type: 'LIKED_CLIMBS' });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(result.current.allClimbs).toEqual([]);

    rerender({ activeBoardInput: KILTER, type: 'FIVE_STARS' });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(result.current.allClimbs).toEqual([]);
    client.clear();
  });
});

describe('removeClimbFromLikedList', () => {
  function seed(client: QueryClient, key: readonly unknown[], pages: string[][]) {
    client.setQueryData(key, {
      pages: pages.map((uuids) => smartPage(uuids).smartPlaylist),
      pageParams: pages.map((_, index) => index),
    });
  }

  it('drops the climb from every cached page of every Liked view and leaves other lists alone', () => {
    const client = new QueryClient();
    const likedKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    const otherBoardKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u', boardUuid: 'b' });
    const logbookKey = smartPlaylistQueryKey({ smartPlaylistType: 'LOGBOOK', userId: 'u' } as never);
    seed(client, likedKey, [['a', 'b'], ['c']]);
    seed(client, otherBoardKey, [['b']]);
    seed(client, logbookKey, [['b']]);

    removeClimbFromLikedList(client, 'b');

    const liked = client.getQueryData<{ pages: { climbs: { uuid: string }[]; totalCount: number }[] }>(likedKey);
    expect(liked?.pages.map((page) => page.climbs.map((climb) => climb.uuid))).toEqual([['a'], ['c']]);
    expect(liked?.pages[0].totalCount).toBe(1);
    const other = client.getQueryData<{ pages: { climbs: unknown[] }[] }>(otherBoardKey);
    expect(other?.pages[0].climbs).toEqual([]);
    const logbook = client.getQueryData<{ pages: { climbs: unknown[] }[] }>(logbookKey);
    expect(logbook?.pages[0].climbs).toHaveLength(1);
  });

  it('drops the list-wide total on every page when the climb sat on a later page', () => {
    const client = new QueryClient();
    const likedKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    client.setQueryData(likedKey, {
      pages: [
        { ...smartPage(['a', 'b']).smartPlaylist, totalCount: 3, hasMore: true },
        { ...smartPage(['c']).smartPlaylist, totalCount: 3 },
      ],
      pageParams: [0, 1],
    });

    removeClimbFromLikedList(client, 'c');

    const liked = client.getQueryData<{ pages: { climbs: { uuid: string }[]; totalCount: number }[] }>(likedKey);
    expect(liked?.pages.map((page) => page.climbs.map((climb) => climb.uuid))).toEqual([['a', 'b'], []]);
    expect(liked?.pages.map((page) => page.totalCount)).toEqual([2, 2]);
  });

  it('keeps the Liked key layout the offline-sync invalidation map matches on', () => {
    expect(smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' }).slice(0, 2)).toEqual(
      LIKED_LIST_QUERY_KEY_PREFIX,
    );
  });

  it('puts a removed climb back where it was, once, and only in views still missing it', () => {
    const client = new QueryClient();
    const likedKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    seed(client, likedKey, [['a', 'b'], ['c']]);

    removeClimbFromLikedList(client, 'b');
    restoreClimbToLikedList(client, 'b');
    restoreClimbToLikedList(client, 'b');

    const liked = client.getQueryData<{ pages: { climbs: { uuid: string }[]; totalCount: number }[] }>(likedKey);
    expect(liked?.pages.map((page) => page.climbs.map((climb) => climb.uuid))).toEqual([['a', 'b'], ['c']]);
    expect(liked?.pages.map((page) => page.totalCount)).toEqual([2, 1]);
  });

  it('remembers only the most recent un-liked climbs for a re-like', () => {
    const client = new QueryClient();
    const likedKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    const uuids = Array.from({ length: MAX_REMEMBERED_UNLIKED_CLIMBS + 1 }, (_, index) => `c${index}`);
    seed(client, likedKey, [uuids]);

    for (const uuid of uuids) removeClimbFromLikedList(client, uuid);
    restoreClimbToLikedList(client, 'c0');
    restoreClimbToLikedList(client, 'c1');

    const liked = client.getQueryData<{ pages: { climbs: { uuid: string }[] }[] }>(likedKey);
    // c0 was the oldest, so it fell past the cap; c1 is still remembered.
    expect(liked?.pages[0].climbs.map((climb) => climb.uuid)).toEqual(['c1']);
  });

  it('drops the header count to zero with the last liked climb, on every page (#7024)', () => {
    const client = new QueryClient();
    const likedKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    seed(client, likedKey, [['only']]);

    removeClimbFromLikedList(client, 'only');

    const liked = client.getQueryData<{ pages: { climbs: unknown[]; meta: { climbCount: number } }[] }>(likedKey);
    expect(liked?.pages[0].climbs).toEqual([]);
    expect(liked?.pages.map((page) => page.meta.climbCount)).toEqual([0]);
  });

  it('drops the unfiltered count of a filtered view and leaves a plain view without one (#7024)', () => {
    const client = new QueryClient();
    const plainKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    const filteredKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u', view: HARDEST_FIRST });
    seed(client, plainKey, [['a', 'b']]);
    client.setQueryData(filteredKey, {
      pages: [
        { ...smartPage(['b']).smartPlaylist, meta: { ...smartPage(['b']).smartPlaylist.meta, climbCount: 5 } },
      ].map((page) => ({ ...page, unfilteredCount: 5 })),
      pageParams: [0],
    });

    removeClimbFromLikedList(client, 'b');

    type CachedCounts = { pages: { meta: { climbCount: number }; unfilteredCount: number | null }[] };
    const plain = client.getQueryData<CachedCounts>(plainKey);
    expect(plain?.pages[0].meta.climbCount).toBe(1);
    expect(plain?.pages[0].unfilteredCount).toBeNull();
    const filtered = client.getQueryData<CachedCounts>(filteredKey);
    expect(filtered?.pages[0].meta.climbCount).toBe(4);
    expect(filtered?.pages[0].unfilteredCount).toBe(4);

    restoreClimbToLikedList(client, 'b');

    expect(client.getQueryData<CachedCounts>(plainKey)?.pages[0].meta.climbCount).toBe(2);
    expect(client.getQueryData<CachedCounts>(plainKey)?.pages[0].unfilteredCount).toBeNull();
    expect(client.getQueryData<CachedCounts>(filteredKey)?.pages[0].meta.climbCount).toBe(5);
    expect(client.getQueryData<CachedCounts>(filteredKey)?.pages[0].unfilteredCount).toBe(5);
  });

  it('hands the screen a header count that follows an un-like and a re-like (#7024)', async () => {
    const execute = vi.fn(async () => smartPage(['only']));
    const { client, wrapper } = renderWithAdapter(execute);
    const { result } = renderHook(() => useSmartPlaylist({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'climber' }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.meta?.climbCount).toBe(1));

    removeClimbFromLikedList(client, 'only');
    await waitFor(() => expect(result.current.allClimbs).toEqual([]));
    expect(result.current.meta?.climbCount).toBe(0);

    restoreClimbToLikedList(client, 'only');
    await waitFor(() => expect(result.current.meta?.climbCount).toBe(1));
    expect(execute).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('does nothing for a climb it never removed', () => {
    const client = new QueryClient();
    const likedKey = smartPlaylistQueryKey({ smartPlaylistType: 'LIKED_CLIMBS', userId: 'u' });
    seed(client, likedKey, [['a']]);
    const before = client.getQueryData(likedKey);

    restoreClimbToLikedList(client, 'z');

    expect(client.getQueryData(likedKey)).toBe(before);
  });
});
