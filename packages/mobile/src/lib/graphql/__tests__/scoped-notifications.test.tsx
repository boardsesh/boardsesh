// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GroupedNotification, GroupedNotificationConnection } from '@boardsesh/shared-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpQueryScope } from '../http-query-scope';

const selected = vi.hoisted(() => ({ scope: null as HttpQueryScope | null }));
vi.mock('../use-http-query-scope', () => ({
  useHttpQueryScope: () => {
    if (!selected.scope) throw new Error('Missing owned notifications fixture');
    return selected.scope;
  },
}));
vi.mock('../use-auth-token', () => ({ useAuthToken: () => ({ data: 'owned-token-label' }) }));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));

import { createScopedHttpFixture } from './fixtures/scoped-http';
import {
  GROUPED_NOTIFICATIONS_QUERY_KEY,
  NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
  useAnswerFollowRequestMutation,
  useGroupedNotifications,
  useMarkAllAsRead,
  useMarkGroupAsRead,
  useNotificationActors,
  useUnreadNotificationCount,
} from '../hooks/use-notifications';
import { NOTIFICATION_ACTORS_QUERY_KEY } from '../notification-actors-key';

const closeFixtures: (() => void)[] = [];
afterEach(() => {
  cleanup();
  closeFixtures.splice(0).forEach((close) => close());
  selected.scope = null;
});
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  closeFixtures.push(() => {
    cache.clear();
    http.dispose();
  });
  return { ...http, cache, wrapper };
}
function group(uuid: string): GroupedNotification {
  return {
    uuid,
    type: 'follow_request',
    entityType: null,
    entityId: `requester-${uuid}`,
    actorCount: 1,
    actors: [{ id: `requester-${uuid}`, displayName: uuid, avatarUrl: null }],
    commentBody: null,
    climbName: null,
    climbUuid: null,
    boardType: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-08-14T10:00:00.000Z',
  } as GroupedNotification;
}
function page(uuid: string, unreadCount = 9): GroupedNotificationConnection {
  return { groups: [group(uuid)], totalCount: 1, unreadCount, hasMore: false };
}
function pages(uuid: string) {
  return { pages: [page(uuid)], pageParams: [0] };
}
function heldResponse(payload: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: payload })));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function useNotificationReads() {
  return {
    grouped: useGroupedNotifications(),
    actors: useNotificationActors('follow_request'),
    unread: useUnreadNotificationCount(),
  };
}
function useNotificationWrites() {
  return {
    group: useMarkGroupAsRead(),
    all: useMarkAllAsRead(),
    answer: useAnswerFollowRequestMutation(),
  };
}
function responsePayload(document: string, uuid: string) {
  if (document.includes('groupedNotifications')) return { groupedNotifications: page(uuid) };
  if (document.includes('notificationActors'))
    return { notificationActors: { users: [{ id: uuid }], totalCount: 1, hasMore: false } };
  return { unreadNotificationCount: 9 };
}
function requestDocument(init: unknown) {
  return (JSON.parse((init as RequestInit).body as string) as { query: string }).query;
}
const actorsKey = [NOTIFICATION_ACTORS_QUERY_KEY, 'follow_request', null, null];

describe('actual scoped notification query and mutation consumers', () => {
  it.each(['B', 'ABA'] as const)(
    'keeps delayed grouped, actors and unread bodies out of the new %s view',
    async (change) => {
      const current = fixture();
      const original = selected.scope!;
      const held: ReturnType<typeof heldResponse>[] = [];
      current.performFetch.mockImplementation(async (_url, init) => {
        const body = heldResponse(responsePayload(requestDocument(init), 'old-A'));
        held.push(body);
        return body.response;
      });
      const { result, rerender } = renderHook(useNotificationReads, current);
      await waitFor(() => expect(held).toHaveLength(3));
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      selected.scope = current.scope();
      current.performFetch.mockImplementation(async (_url, init) =>
        Response.json({ data: responsePayload(requestDocument(init), 'fresh-owner') }),
      );
      rerender();
      await waitFor(() => expect(result.current.grouped.data?.pages[0].groups[0].uuid).toBe('fresh-owner'));
      await waitFor(() => expect(result.current.actors.data?.pages[0].users[0].id).toBe('fresh-owner'));
      await waitFor(() => expect(result.current.unread).toBe(9));
      await act(async () => {
        held.forEach((body) => body.release());
      });
      expect(result.current.grouped.data?.pages[0].groups[0].uuid).toBe('fresh-owner');
      expect(result.current.actors.data?.pages[0].users[0].id).toBe('fresh-owner');
      for (const key of [GROUPED_NOTIFICATIONS_QUERY_KEY, NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, actorsKey]) {
        expect(current.cache.getQueryData(original.key(key))).toBeUndefined();
        expect(current.cache.getQueryData(key)).toBeUndefined();
      }
      expect(current.cache.getQueryData(selected.scope.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY))).toBe(9);
    },
  );

  it('leaves all authenticated notification reads idle while required central admission is unavailable', async () => {
    const current = fixture();
    selected.scope = Object.freeze({ ...selected.scope!, isReady: () => false });
    const { result } = renderHook(useNotificationReads, current);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.grouped.fetchStatus).toBe('idle');
    expect(result.current.actors.fetchStatus).toBe('idle');
    expect(result.current.unread).toBe(0);
    expect(current.issueLease).not.toHaveBeenCalled();
    expect(current.performFetch).not.toHaveBeenCalled();
  });

  it.each(['group', 'all', 'answer'] as const)(
    'refuses a delayed %s write after B, ABA or expiry before any cache publication',
    async (kind) => {
      for (const change of ['B', 'ABA', 'expired'] as const) {
        const current = fixture();
        const original = selected.scope!;
        current.cache.setQueryData(original.key(GROUPED_NOTIFICATIONS_QUERY_KEY), pages('A'));
        current.cache.setQueryData(original.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY), 9);
        const held = heldResponse({
          markGroupNotificationsRead: 3,
          markAllNotificationsRead: true,
          approveFollowRequest: true,
        });
        current.performFetch.mockResolvedValueOnce(held.response);
        const { result, rerender, unmount } = renderHook(useNotificationWrites, current);
        let pending!: Promise<unknown>;
        act(() => {
          pending =
            kind === 'group'
              ? result.current.group.mutateAsync(group('A'))
              : kind === 'all'
                ? result.current.all.mutateAsync()
                : result.current.answer.mutateAsync({ notification: group('A'), answer: 'approve' });
        });
        const refused = expect(pending).rejects.toThrow();
        await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
        if (change === 'expired') current.clock(120_001);
        else {
          current.switchAccount('owned-B');
          if (change === 'ABA') current.switchAccount('owned-A');
          selected.scope = current.scope();
          current.cache.setQueryData(selected.scope.key(GROUPED_NOTIFICATIONS_QUERY_KEY), pages('fresh-owner'));
          current.cache.setQueryData(selected.scope.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY), 9);
          rerender();
        }
        await act(async () => {
          held.release();
          await refused;
        });
        expect(current.cache.getQueryData(original.key(GROUPED_NOTIFICATIONS_QUERY_KEY))).toEqual(pages('A'));
        expect(current.cache.getQueryData(original.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY))).toBe(9);
        if (change !== 'expired')
          expect(current.cache.getQueryData(selected.scope!.key(GROUPED_NOTIFICATIONS_QUERY_KEY))).toEqual(
            pages('fresh-owner'),
          );
        expect(current.cache.getQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY)).toBeUndefined();
        expect(current.cache.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBeUndefined();
        unmount();
      }
    },
  );

  it('uses only the original scoped cache for group and all-read arithmetic', async () => {
    const current = fixture();
    const original = selected.scope!;
    current.cache.setQueryData(original.key(GROUPED_NOTIFICATIONS_QUERY_KEY), pages('A'));
    current.cache.setQueryData(original.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY), 9);
    current.performFetch.mockImplementation(async (_url, init) =>
      Response.json({
        data: requestDocument(init).includes('markGroupNotificationsRead')
          ? { markGroupNotificationsRead: 3 }
          : { markAllNotificationsRead: true },
      }),
    );
    const { result } = renderHook(useNotificationWrites, current);
    await act(async () => {
      await result.current.group.mutateAsync(group('A'));
    });
    expect(current.cache.getQueryData(original.key(GROUPED_NOTIFICATIONS_QUERY_KEY))).toEqual({
      pages: [{ ...page('A'), groups: [{ ...group('A'), isRead: true }] }],
      pageParams: [0],
    });
    expect(current.cache.getQueryData(original.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY))).toBe(6);
    await act(async () => {
      await result.current.all.mutateAsync();
    });
    expect(current.cache.getQueryData(original.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY))).toBe(0);
    expect(current.cache.getQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY)).toBeUndefined();
    expect(current.cache.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBeUndefined();
  });

  it('keeps answer refetches nonblocking and original-scoped, and exposes the exact receipt to UI callers', async () => {
    const current = fixture();
    const original = selected.scope!;
    current.cache.setQueryData(original.key(GROUPED_NOTIFICATIONS_QUERY_KEY), pages('A'));
    current.cache.setQueryData(original.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY), 9);
    current.performFetch.mockResolvedValueOnce(Response.json({ data: { approveFollowRequest: true } }));
    let release!: () => void;
    const invalidate = vi.spyOn(current.cache, 'invalidateQueries').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(useNotificationWrites, current);
    const accepted = await result.current.answer.mutateWithReceipt({ notification: group('A'), answer: 'approve' });
    accepted.assertCurrent();
    expect(current.cache.getQueryData(original.key(GROUPED_NOTIFICATIONS_QUERY_KEY))).toEqual({
      pages: [{ ...page('A'), groups: [] }],
      pageParams: [0],
    });
    expect(current.cache.getQueryData(original.key(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY))).toBe(8);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      original.key(['privacyFollowRequests']),
      original.key(['followers']),
      original.key(['following']),
      original.key(['publicProfile']),
      original.key(['privacyRelationship']),
    ]);
    current.switchAccount('owned-B');
    await act(async () => {
      release();
    });
    expect(() => accepted.assertCurrent()).toThrow();
    expect(current.cache.getQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY)).toBeUndefined();
    expect(current.cache.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBeUndefined();
  });
});
