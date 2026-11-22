// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type InfiniteData, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppBugReport,
  AppBugReportConnection,
  AppBugReportMessage,
  AppBugReportMessageConnection,
  GroupedNotification,
  GroupedNotificationConnection,
} from '@boardsesh/shared-schema';
import {
  APP_BUG_REPORT_MESSAGES,
  GET_UNREAD_NOTIFICATION_COUNT,
  MARK_GROUP_NOTIFICATIONS_READ,
  SEND_APP_BUG_REPORT_MESSAGE,
  RETRY_APP_BUG_REPORT_MESSAGE,
} from '@boardsesh/graphql/operations';
import {
  useAppBugReport,
  useAppBugReportMessages,
  useMarkAppBugReportRead,
  useMyAppBugReports,
  useRetryAppBugReportMessage,
  useSendAppBugReportMessage,
} from '../use-bug-reports';
import { bugReportQueryKeys } from '../bug-report-query-keys';
import {
  GROUPED_NOTIFICATIONS_QUERY_KEY,
  NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
} from '../../graphql/notification-read-cache';
import { useGroupedNotifications, useUnreadNotificationCount } from '../../graphql/hooks/use-notifications';

const request = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ generation: 1 }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: 'token' }) }));
vi.mock('../../auth-store', () => ({
  captureAuthCredentialGeneration: () => auth.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === auth.generation,
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    client,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

function report(id: string): AppBugReport {
  return {
    id,
    comment: 'A report',
    createdAt: '2026-11-21T10:00:00Z',
    status: 'new',
    screenshotUrls: [],
    canReply: true,
  };
}
function connection(id: string, hasMore = false): AppBugReportConnection {
  return { reports: [report(id)], hasMore, endCursor: id };
}
function message(overrides: Partial<AppBugReportMessage> = {}): AppBugReportMessage {
  return {
    id: '101',
    reportId: '42',
    body: 'More detail',
    authorRole: 'reporter',
    deliveryStatus: 'pending',
    createdAt: '2026-11-21T10:00:00Z',
    ...overrides,
  };
}

function messagePages(): InfiniteData<AppBugReportMessageConnection> {
  return {
    pages: [
      { messages: [message({ id: '100', deliveryStatus: 'sent' })], hasMore: true, endCursor: 'older-messages' },
      { messages: [message({ id: '50', deliveryStatus: 'sent' })], hasMore: false, endCursor: 'last-message' },
    ],
    pageParams: [null, 'older-messages'],
  };
}

const replyInput = {
  reportId: '42',
  body: 'More detail',
  clientMutationId: '11111111-2222-4333-8444-555555555555',
};

beforeEach(() => {
  request.mockReset();
  auth.generation = 1;
});

describe('bug-report queries', () => {
  it('does not request history without an account id', async () => {
    const { Wrapper } = wrapper();
    const hook = renderHook(() => useMyAppBugReports(undefined), { wrapper: Wrapper });
    await act(async () => {});
    expect(request).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('keeps a late response from the previous account out of the current history', async () => {
    let resolvePrevious: ((result: { myAppBugReports: AppBugReportConnection }) => void) | undefined;
    const previous = new Promise<{ myAppBugReports: AppBugReportConnection }>((resolve) => {
      resolvePrevious = resolve;
    });
    request
      .mockReturnValueOnce(previous)
      .mockResolvedValueOnce({ myAppBugReports: connection('second-account-report') });
    const { Wrapper, client } = wrapper();
    const hook = renderHook(({ accountId }) => useMyAppBugReports(accountId), {
      wrapper: Wrapper,
      initialProps: { accountId: 'first-account' },
    });
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    hook.rerender({ accountId: 'second-account' });
    await waitFor(() => expect(hook.result.current.data?.pages[0].reports[0].id).toBe('second-account-report'));
    await act(async () => resolvePrevious?.({ myAppBugReports: connection('first-account-report') }));
    expect(hook.result.current.data?.pages[0].reports[0].id).toBe('second-account-report');
    expect(client.getQueryData(bugReportQueryKeys.list('first-account'))).toBeDefined();
    hook.unmount();
  });

  it('loads one page using the server cursor and stops when hasMore is false', async () => {
    request
      .mockResolvedValueOnce({ myAppBugReports: connection('42', true) })
      .mockResolvedValueOnce({ myAppBugReports: connection('17') });
    const { Wrapper } = wrapper();
    const hook = renderHook(() => useMyAppBugReports('account'), { wrapper: Wrapper });
    await waitFor(() => expect(hook.result.current.hasNextPage).toBe(true));
    await act(async () => {
      await hook.result.current.fetchNextPage();
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]).toEqual({ input: { limit: 20, after: '42' } });
    await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(2));
    expect(hook.result.current.hasNextPage).toBe(false);
    hook.unmount();
  });

  it('sends one reply without refetching active paginated caches', async () => {
    request.mockResolvedValueOnce({ sendAppBugReportMessage: message() });
    const { Wrapper, client } = wrapper();
    const history = { pages: [connection('42', true), connection('17')], pageParams: [null, '42'] };
    const messages = messagePages();
    client.setQueryData(bugReportQueryKeys.list('account'), history);
    client.setQueryData(bugReportQueryKeys.report('account', '42'), report('42'));
    client.setQueryData(bugReportQueryKeys.messages('account', '42'), messages);
    client.setQueryData(bugReportQueryKeys.messages('another-account', '42'), messages);
    const hook = renderHook(
      () => {
        useMyAppBugReports('account');
        useAppBugReport('account', '42');
        useAppBugReportMessages('account', '42', true);
        return useSendAppBugReportMessage('account', '42');
      },
      { wrapper: Wrapper },
    );
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.mutateAsync(replyInput);
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(SEND_APP_BUG_REPORT_MESSAGE, { input: replyInput });
    const cached = client.getQueryData<InfiniteData<AppBugReportMessageConnection>>(
      bugReportQueryKeys.messages('account', '42'),
    );
    expect(cached?.pages[0].messages.map((cachedMessage) => cachedMessage.id)).toEqual(['101', '100']);
    expect(cached?.pages[0].endCursor).toBe('older-messages');
    expect(cached?.pages[0].hasMore).toBe(true);
    expect(cached?.pages[1]).toEqual(messages.pages[1]);
    expect(cached?.pageParams).toEqual(messages.pageParams);
    expect(client.getQueryData(bugReportQueryKeys.list('account'))).toEqual(history);
    expect(client.getQueryData(bugReportQueryKeys.messages('another-account', '42'))).toEqual(messages);
    expect(client.getQueryState(bugReportQueryKeys.list('account'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(bugReportQueryKeys.report('account', '42'))?.isInvalidated).toBe(true);
    hook.unmount();
    client.clear();
  });

  it('retries a persisted message in its existing page without refetching or duplicating it', async () => {
    request.mockResolvedValueOnce({ retryAppBugReportMessage: message() });
    const { Wrapper, client } = wrapper();
    const messages = messagePages();
    messages.pages[1].messages.push(message({ deliveryStatus: 'failed' }));
    client.setQueryData(bugReportQueryKeys.messages('account', '42'), messages);
    const hook = renderHook(
      () => {
        useAppBugReportMessages('account', '42', true);
        return useRetryAppBugReportMessage('account', '42');
      },
      { wrapper: Wrapper },
    );
    await act(async () => {
      await hook.result.current.mutateAsync('101');
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(RETRY_APP_BUG_REPORT_MESSAGE, { id: '101' });
    const cached = client.getQueryData<InfiniteData<AppBugReportMessageConnection>>(
      bugReportQueryKeys.messages('account', '42'),
    );
    expect(cached?.pages[0]).toEqual(messages.pages[0]);
    expect(cached?.pages[1].messages.map((cachedMessage) => cachedMessage.id)).toEqual(['50', '101']);
    expect(cached?.pages[1].messages[1].deliveryStatus).toBe('pending');
    expect(cached?.pageParams).toEqual(messages.pageParams);
    hook.unmount();
    client.clear();
  });

  it('keeps a delivered message when a late send response still says pending', async () => {
    const { Wrapper, client } = wrapper();
    const messages = messagePages();
    const delivered = message({ deliveryStatus: 'sent', body: 'Canonical reply' });
    messages.pages[0].messages.unshift(delivered);
    client.setQueryData(bugReportQueryKeys.messages('account', '42'), messages);
    request.mockResolvedValueOnce({ sendAppBugReportMessage: message() });
    const hook = renderHook(() => useSendAppBugReportMessage('account', '42'), { wrapper: Wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync(replyInput);
    });
    expect(client.getQueryData(bugReportQueryKeys.messages('account', '42'))).toEqual(messages);
    expect(request).toHaveBeenCalledOnce();
    hook.unmount();
    client.clear();
  });

  it('ignores an older in-flight read after caching the returned reply', async () => {
    let resolveRead: ((response: { appBugReportMessages: AppBugReportMessageConnection }) => void) | undefined;
    const earlierRead = new Promise<{ appBugReportMessages: AppBugReportMessageConnection }>((resolve) => {
      resolveRead = resolve;
    });
    request.mockImplementation((document: unknown) =>
      document === APP_BUG_REPORT_MESSAGES ? earlierRead : Promise.resolve({ sendAppBugReportMessage: message() }),
    );
    const { Wrapper, client } = wrapper();
    client.setQueryData(bugReportQueryKeys.messages('account', '42'), messagePages());
    const hook = renderHook(
      () => ({
        messages: useAppBugReportMessages('account', '42', true),
        send: useSendAppBugReportMessage('account', '42'),
      }),
      { wrapper: Wrapper },
    );
    act(() => void hook.result.current.messages.refetch());
    await act(async () => {
      await hook.result.current.send.mutateAsync(replyInput);
    });
    await act(async () => {
      resolveRead?.({ appBugReportMessages: { messages: [], hasMore: false, endCursor: null } });
    });
    const cached = client.getQueryData<InfiniteData<AppBugReportMessageConnection>>(
      bugReportQueryKeys.messages('account', '42'),
    );
    expect(cached?.pages[0].messages[0]).toEqual(message());
    expect(cached?.pages).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    hook.unmount();
    client.clear();
  });

  it.each(['send', 'retry'] as const)(
    'preserves a canonical delivery read that starts before the %s response returns',
    async (operation) => {
      let resolveMutation:
        | ((response: {
            sendAppBugReportMessage: AppBugReportMessage;
            retryAppBugReportMessage: AppBugReportMessage;
          }) => void)
        | undefined;
      const pendingMutation = new Promise<{
        sendAppBugReportMessage: AppBugReportMessage;
        retryAppBugReportMessage: AppBugReportMessage;
      }>((resolve) => {
        resolveMutation = resolve;
      });
      let resolveCanonicalRead:
        | ((response: { appBugReportMessages: AppBugReportMessageConnection }) => void)
        | undefined;
      const canonicalRead = new Promise<{ appBugReportMessages: AppBugReportMessageConnection }>((resolve) => {
        resolveCanonicalRead = resolve;
      });
      request.mockImplementation((document: unknown) =>
        document === APP_BUG_REPORT_MESSAGES ? canonicalRead : pendingMutation,
      );
      const { Wrapper, client } = wrapper();
      client.setQueryData(bugReportQueryKeys.messages('account', '42'), {
        pages: [
          {
            messages: operation === 'retry' ? [message({ deliveryStatus: 'failed' })] : [],
            hasMore: false,
            endCursor: null,
          },
        ],
        pageParams: [null],
      });
      const hook = renderHook(
        () => ({
          messages: useAppBugReportMessages('account', '42', true),
          send: useSendAppBugReportMessage('account', '42'),
          retry: useRetryAppBugReportMessage('account', '42'),
        }),
        { wrapper: Wrapper },
      );
      let mutationResult: Promise<AppBugReportMessage> | undefined;
      act(() => {
        mutationResult =
          operation === 'send'
            ? hook.result.current.send.mutateAsync(replyInput)
            : hook.result.current.retry.mutateAsync('101');
      });
      await waitFor(() => expect(request).toHaveBeenCalledOnce());

      // A live delivery event can arrive while its mutation's HTTP response is
      // still in flight. That read owns the newer, canonical delivery state.
      act(() => void hook.result.current.messages.refetch());
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await act(async () => {
        resolveMutation?.({ sendAppBugReportMessage: message(), retryAppBugReportMessage: message() });
        await mutationResult;
      });
      expect(client.getQueryState(bugReportQueryKeys.messages('account', '42'))?.fetchStatus).toBe('fetching');
      const delivered = message({ deliveryStatus: 'sent', body: 'Canonical delivery' });
      await act(async () => {
        resolveCanonicalRead?.({ appBugReportMessages: { messages: [delivered], hasMore: false, endCursor: '101' } });
      });
      await waitFor(() => {
        const cached = client.getQueryData<InfiniteData<AppBugReportMessageConnection>>(
          bugReportQueryKeys.messages('account', '42'),
        );
        expect(cached?.pages[0].messages).toEqual([delivered]);
      });
      expect(request).toHaveBeenCalledTimes(2);
      hook.unmount();
      client.clear();
    },
  );

  it('leaves hidden multi-page report history stale until the screen is focused', async () => {
    request.mockImplementation((_document: unknown, variables: { input: { after: string | null } }) =>
      Promise.resolve({
        myAppBugReports: connection(variables.input.after === null ? '42' : '17', variables.input.after === null),
      }),
    );
    const { Wrapper, client } = wrapper();
    client.setQueryData(bugReportQueryKeys.list('account'), {
      pages: [connection('42', true), connection('17')],
      pageParams: [null, '42'],
    });
    const hook = renderHook(({ focused }) => useMyAppBugReports('account', focused), {
      wrapper: Wrapper,
      initialProps: { focused: false },
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: bugReportQueryKeys.list('account') });
    });
    expect(request).not.toHaveBeenCalled();
    hook.rerender({ focused: true });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([, variables]) => variables.input.after)).toEqual([null, '42']);
    hook.unmount();
    client.clear();
  });

  it('makes no polling requests from an idle thread with a pending message', async () => {
    vi.useFakeTimers();
    const { Wrapper, client } = wrapper();
    client.setQueryData(bugReportQueryKeys.report('account', '42'), report('42'));
    client.setQueryData(bugReportQueryKeys.messages('account', '42'), {
      pages: [{ messages: [message()], hasMore: false, endCursor: null }],
      pageParams: [null],
    });
    const hook = renderHook(
      () => {
        useAppBugReport('account', '42');
        useAppBugReportMessages('account', '42', true);
      },
      { wrapper: Wrapper },
    );
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
      client.clear();
      vi.useRealTimers();
    }
  });

  it('marks only this report read and leaves the unread count stale without guessing its baseline', async () => {
    request
      .mockResolvedValueOnce({ markGroupNotificationsRead: 3 })
      .mockResolvedValueOnce({ markGroupNotificationsRead: 0 });
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const group = (
      entityId: string,
      type: GroupedNotification['type'] = 'app_feedback_reply',
    ): GroupedNotification => ({
      uuid: `group-${type}-${entityId}`,
      type,
      entityType: null,
      entityId,
      actorCount: 1,
      actors: [],
      isRead: false,
      createdAt: '2026-11-21T10:00:00Z',
    });
    client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 8);
    client.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
      pages: [
        { groups: [group('42'), group('17')], totalCount: 3, unreadCount: 8, hasMore: true },
        { groups: [group('42', 'comment_reply')], totalCount: 3, unreadCount: 8, hasMore: false },
      ],
      pageParams: [0, 2],
    });
    const hook = renderHook(() => useMarkAppBugReportRead('42'), { wrapper: Wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync();
    });
    const cached = client.getQueryData<InfiniteData<GroupedNotificationConnection>>(GROUPED_NOTIFICATIONS_QUERY_KEY);
    expect(cached?.pages[0].groups.map((notification) => notification.isRead)).toEqual([true, false]);
    expect(cached?.pages[1].groups[0].isRead).toBe(false);
    expect(cached?.pages.map((page) => page.unreadCount)).toEqual([8, 8]);
    expect(cached?.pageParams).toEqual([0, 2]);
    expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(8);
    expect(client.getQueryState(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)?.isInvalidated).toBe(true);
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY, refetchType: 'none' }],
      [{ queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, exact: true }, { cancelRefetch: false }],
    ]);
    await act(async () => {
      await hook.result.current.mutateAsync();
    });
    expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(8);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    hook.unmount();
    client.clear();
  });

  it('keeps a previous account’s late acknowledgement out of the current bell cache', async () => {
    let resolveAcknowledgement: ((response: { markGroupNotificationsRead: number }) => void) | undefined;
    request.mockReturnValueOnce(
      new Promise<{ markGroupNotificationsRead: number }>((resolve) => {
        resolveAcknowledgement = resolve;
      }),
    );
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 8);
    const hook = renderHook(() => useMarkAppBugReportRead('42'), { wrapper: Wrapper });
    let acknowledgement: Promise<number> | undefined;
    act(() => {
      acknowledgement = hook.result.current.mutateAsync();
    });
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    auth.generation += 1;
    client.clear();
    const nextAccountHistory = {
      pages: [{ groups: [], totalCount: 0, unreadCount: 17, hasMore: false }],
      pageParams: [0],
    };
    client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 17);
    client.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, nextAccountHistory);
    await act(async () => {
      resolveAcknowledgement?.({ markGroupNotificationsRead: 3 });
      await acknowledgement;
    });
    expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(17);
    expect(client.getQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY)).toEqual(nextAccountHistory);
    expect(invalidate).not.toHaveBeenCalled();
    hook.unmount();
    client.clear();
  });

  it.each([5, 2])(
    'reconciles an in-flight bell snapshot of %i without refetching hidden notification pages',
    async (snapshotCount) => {
      let resolveCount: ((response: { unreadNotificationCount: number }) => void) | undefined;
      const pendingCount = new Promise<{ unreadNotificationCount: number }>((resolve) => {
        resolveCount = resolve;
      });
      let countRequests = 0;
      request.mockImplementation((document: unknown) => {
        if (document === MARK_GROUP_NOTIFICATIONS_READ) return Promise.resolve({ markGroupNotificationsRead: 3 });
        if (document === GET_UNREAD_NOTIFICATION_COUNT) {
          countRequests += 1;
          return countRequests === 1 ? pendingCount : Promise.resolve({ unreadNotificationCount: 2 });
        }
        throw new Error('A hidden notification list must not be requested');
      });
      const { Wrapper, client } = wrapper();
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 5);
      const hiddenHistory = {
        pages: [
          { groups: [], totalCount: 2, unreadCount: 5, hasMore: true },
          { groups: [], totalCount: 2, unreadCount: 5, hasMore: false },
        ],
        pageParams: [0, 1],
      };
      client.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, hiddenHistory);
      const hook = renderHook(
        () => {
          useGroupedNotifications(false);
          useUnreadNotificationCount();
          return useMarkAppBugReportRead('42');
        },
        { wrapper: Wrapper },
      );
      act(() => void client.refetchQueries({ queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY }));
      await waitFor(() => expect(request).toHaveBeenCalledOnce());
      let acknowledgement: Promise<number> | undefined;
      act(() => {
        acknowledgement = hook.result.current.mutateAsync();
      });
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await act(async () => {
        resolveCount?.({ unreadNotificationCount: snapshotCount });
        await acknowledgement;
      });
      expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(2);
      expect(client.getQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY)).toEqual(hiddenHistory);
      expect(countRequests).toBe(2);
      expect(request).toHaveBeenCalledTimes(3);
      expect(invalidate.mock.calls).toEqual([
        [{ queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY, refetchType: 'none' }],
        [{ queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, exact: true }, { cancelRefetch: false }],
      ]);
      hook.unmount();
      client.clear();
    },
  );

  it('rechecks the account after awaiting an in-flight bell response', async () => {
    let resolveCount: ((response: { unreadNotificationCount: number }) => void) | undefined;
    const pendingCount = new Promise<{ unreadNotificationCount: number }>((resolve) => {
      resolveCount = resolve;
    });
    request.mockImplementation((document: unknown) =>
      document === GET_UNREAD_NOTIFICATION_COUNT ? pendingCount : Promise.resolve({ markGroupNotificationsRead: 3 }),
    );
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 5);
    const hook = renderHook(
      () => {
        useUnreadNotificationCount();
        return useMarkAppBugReportRead('42');
      },
      { wrapper: Wrapper },
    );
    act(() => void client.refetchQueries({ queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    let acknowledgement: Promise<number> | undefined;
    act(() => {
      acknowledgement = hook.result.current.mutateAsync();
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    auth.generation += 1;
    client.clear();
    client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 17);
    await act(async () => {
      resolveCount?.({ unreadNotificationCount: 5 });
      await acknowledgement;
    });
    expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(17);
    expect(invalidate).not.toHaveBeenCalled();
    hook.unmount();
    client.clear();
  });

  it('refreshes an active badge once after acknowledging a reply and leaves hidden grouped pages unfetched', async () => {
    request.mockImplementation((document: unknown) => {
      if (document === MARK_GROUP_NOTIFICATIONS_READ) return Promise.resolve({ markGroupNotificationsRead: 3 });
      if (document === GET_UNREAD_NOTIFICATION_COUNT) return Promise.resolve({ unreadNotificationCount: 5 });
      throw new Error('A hidden notification list must not be requested');
    });
    const { Wrapper, client } = wrapper();
    client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 8);
    client.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
      pages: [
        { groups: [], totalCount: 2, unreadCount: 8, hasMore: true },
        { groups: [], totalCount: 2, unreadCount: 8, hasMore: false },
      ],
      pageParams: [0, 1],
    });
    const hook = renderHook(
      () => {
        useGroupedNotifications(false);
        useUnreadNotificationCount();
        return useMarkAppBugReportRead('42');
      },
      { wrapper: Wrapper },
    );
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.mutateAsync();
    });
    expect(request.mock.calls.map(([document]) => document)).toEqual([
      MARK_GROUP_NOTIFICATIONS_READ,
      GET_UNREAD_NOTIFICATION_COUNT,
    ]);
    expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(5);
    expect(client.getQueryState(GROUPED_NOTIFICATIONS_QUERY_KEY)?.isInvalidated).toBe(true);
    hook.unmount();
    client.clear();
  });

  it('does not subtract again when a completed unread read already includes the acknowledgement', async () => {
    let resolveAcknowledgement: ((response: { markGroupNotificationsRead: number }) => void) | undefined;
    const pendingAcknowledgement = new Promise<{ markGroupNotificationsRead: number }>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    request.mockImplementation((document: unknown) => {
      if (document === MARK_GROUP_NOTIFICATIONS_READ) return pendingAcknowledgement;
      if (document === GET_UNREAD_NOTIFICATION_COUNT) return Promise.resolve({ unreadNotificationCount: 5 });
      throw new Error('A hidden notification list must not be requested');
    });
    const { Wrapper, client } = wrapper();
    client.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 6);
    const hook = renderHook(
      () => {
        useGroupedNotifications(false);
        useUnreadNotificationCount();
        return useMarkAppBugReportRead('42');
      },
      { wrapper: Wrapper },
    );
    let acknowledgement: Promise<number> | undefined;
    act(() => {
      acknowledgement = hook.result.current.mutateAsync();
    });
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    // The server committed mark-read, but its mutation response is delayed.
    // An independent count read can already observe the post-mark total.
    await act(async () => {
      await client.refetchQueries({ queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY });
    });
    expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(5);
    expect(client.getQueryState(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)?.fetchStatus).toBe('idle');
    await act(async () => {
      resolveAcknowledgement?.({ markGroupNotificationsRead: 1 });
      await acknowledgement;
    });
    expect(client.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(5);
    expect(request.mock.calls.map(([document]) => document)).toEqual([
      MARK_GROUP_NOTIFICATIONS_READ,
      GET_UNREAD_NOTIFICATION_COUNT,
      GET_UNREAD_NOTIFICATION_COUNT,
    ]);
    hook.unmount();
    client.clear();
  });
});
