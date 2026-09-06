// @vitest-environment jsdom
//
// The cache arithmetic behind the notifications screen. Three things here are
// wrong-by-one if written from memory and invisible in a render test:
//   - the infinite-query offset must count groups ALREADY HELD, not pages × 20;
//   - marking one group read subtracts the count the SERVER marked (a group can
//     hold many rows), not 1;
//   - the grouped query owns the unread count, so the bell settles from the
//     list's own response instead of a second round trip.
//
// Imports the hook file directly rather than the `hooks` barrel — the barrel
// statically reaches react-native's Flow source, which Rolldown's scan refuses
// (same reason `fetch-all-my-boards.test.ts` does).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GroupedNotification, GroupedNotificationConnection } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../use-auth-token', () => ({ useAuthToken: () => ({ data: 'token' }) }));

import {
  GROUPED_NOTIFICATIONS_QUERY_KEY,
  NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
  useGroupedNotifications,
  nextActorsOffset,
  useMarkAllAsRead,
  useMarkGroupAsRead,
} from '../use-notifications';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

function makeGroup(uuid: string, overrides: Partial<GroupedNotification> = {}): GroupedNotification {
  return {
    uuid,
    type: 'new_follower',
    entityType: null,
    entityId: null,
    actorCount: 1,
    actors: [],
    commentBody: null,
    climbName: null,
    climbUuid: null,
    boardType: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  } as GroupedNotification;
}

/** A page whose group count is deliberately SHORT of the 20-row limit, so
 *  "offset += groups received" is distinguishable from "offset = page × 20". */
function makeConnection(groupCount: number, hasMore: boolean, unreadCount = 0): GroupedNotificationConnection {
  return {
    groups: Array.from({ length: groupCount }, (_, index) => makeGroup(`group-${index}`)),
    totalCount: 50,
    unreadCount,
    hasMore,
  } as GroupedNotificationConnection;
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useGroupedNotifications', () => {
  it('offsets the next page by the groups already held, not by the page size', async () => {
    requestMock
      .mockResolvedValueOnce({ groupedNotifications: makeConnection(12, true) })
      .mockResolvedValueOnce({ groupedNotifications: makeConnection(8, false) });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useGroupedNotifications(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock.mock.calls[0][1]).toEqual({ limit: 20, offset: 0 });

    await act(async () => {
      await result.current.fetchNextPage();
    });

    // 12 groups came back, so the second page starts at 12 — not at 20.
    expect(requestMock.mock.calls[1][1]).toEqual({ limit: 20, offset: 12 });
  });

  it('stops paginating once the server clears hasMore', async () => {
    requestMock.mockResolvedValue({ groupedNotifications: makeConnection(5, false) });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useGroupedNotifications(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('publishes the unread count from the list response', async () => {
    requestMock.mockResolvedValue({ groupedNotifications: makeConnection(3, false, 7) });

    const { queryClient, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useGroupedNotifications(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The bell reads this key, so it settles without its own request.
    expect(queryClient.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(7);
  });
});

describe('useMarkGroupAsRead', () => {
  it('flips only the tapped group and subtracts the server-reported count', async () => {
    requestMock.mockResolvedValue({ markGroupNotificationsRead: 3 });

    const { queryClient, Wrapper } = makeWrapper();
    queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 10);
    queryClient.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
      pages: [{ groups: [makeGroup('a'), makeGroup('b')], totalCount: 2, unreadCount: 10, hasMore: false }],
      pageParams: [0],
    });

    const { result } = renderHook(() => useMarkGroupAsRead(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync(makeGroup('a'));
    });

    const cached = queryClient.getQueryData<{ pages: GroupedNotificationConnection[] }>(
      GROUPED_NOTIFICATIONS_QUERY_KEY,
    );
    expect(cached?.pages[0].groups.map((group) => group.isRead)).toEqual([true, false]);
    // A group can hold several notification rows — the badge drops by 3, not 1.
    expect(queryClient.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(7);
  });

  it('never drives the unread count below zero', async () => {
    requestMock.mockResolvedValue({ markGroupNotificationsRead: 5 });

    const { queryClient, Wrapper } = makeWrapper();
    queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 2);

    const { result } = renderHook(() => useMarkGroupAsRead(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync(makeGroup('a'));
    });

    expect(queryClient.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(0);
  });

  it('sends the group identity the server groups by', async () => {
    requestMock.mockResolvedValue({ markGroupNotificationsRead: 1 });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useMarkGroupAsRead(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync(makeGroup('a', { type: 'comment_on_tick', entityType: 'tick', entityId: 'T1' }));
    });

    expect(requestMock.mock.calls[0][1]).toEqual({ type: 'comment_on_tick', entityType: 'tick', entityId: 'T1' });
  });
});

describe('useMarkAllAsRead', () => {
  it('flips every loaded group across every page and zeroes the badge', async () => {
    requestMock.mockResolvedValue({ markAllNotificationsRead: true });

    const { queryClient, Wrapper } = makeWrapper();
    queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 9);
    queryClient.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
      pages: [
        { groups: [makeGroup('a')], totalCount: 3, unreadCount: 9, hasMore: true },
        { groups: [makeGroup('b'), makeGroup('c')], totalCount: 3, unreadCount: 9, hasMore: false },
      ],
      pageParams: [0, 1],
    });

    const { result } = renderHook(() => useMarkAllAsRead(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });

    const cached = queryClient.getQueryData<{ pages: GroupedNotificationConnection[] }>(
      GROUPED_NOTIFICATIONS_QUERY_KEY,
    );
    expect(cached?.pages.flatMap((page) => page.groups).every((group) => group.isRead)).toBe(true);
    expect(queryClient.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(0);
  });
});

describe('nextActorsOffset', () => {
  const page = (count: number, hasMore: boolean) => ({ users: Array.from({ length: count }), hasMore });

  it('offsets by the actors already held, not by pages × page size', () => {
    // 30 then 30: the second page must ask for 60, and a partial last page must
    // not overshoot — pages × 30 would.
    expect(nextActorsOffset(page(30, true), [page(30, true)])).toBe(30);
    expect(nextActorsOffset(page(30, true), [page(30, true), page(30, true)])).toBe(60);
    expect(nextActorsOffset(page(7, true), [page(30, true), page(7, true)])).toBe(37);
  });

  it('stops when the server says there is no more', () => {
    expect(nextActorsOffset(page(30, false), [page(30, false)])).toBeUndefined();
  });

  it('stops on an empty page even when the server still says hasMore', () => {
    // The stuck-offset case: a page that contributes nothing leaves the offset
    // where it was, so the next fetch asks for the same window forever.
    expect(nextActorsOffset(page(0, true), [page(30, true), page(0, true)])).toBeUndefined();
  });
});
