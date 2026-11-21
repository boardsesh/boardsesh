// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBugReport, AppBugReportConnection } from '@boardsesh/shared-schema';
import { APP_BUG_REPORT_CHANGED } from '@boardsesh/graphql/operations';
import { useSprayCompletionUpdates } from '../use-spray-completion-updates';
import { useMyAppBugReports } from '../../lib/feedback/use-bug-reports';
import { bugReportQueryKeys } from '../../lib/feedback/bug-report-query-keys';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  on: vi.fn(),
  removeConnected: vi.fn(),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../lib/graphql/ws-client', () => ({
  getWsClient: () => ({ subscribe: mocks.subscribe, on: mocks.on }),
}));
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ offlineMode: false }),
  subscribeConnectivity: () => () => {},
}));
vi.mock('../../lib/graphql/ws-client-lifecycle', () => ({ subscribeWsClientDisposed: () => () => {} }));

type ReportSink = { next: (payload: { data: { appBugReportChanged: { reportId: string } } }) => void };

function latestReportSink(): ReportSink {
  const subscription = mocks.subscribe.mock.calls.findLast(([operation]) => operation.query === APP_BUG_REPORT_CHANGED);
  if (!subscription) throw new Error('Missing report-change subscription');
  return subscription[1] as ReportSink;
}

function history(status: AppBugReport['status']): { myAppBugReports: AppBugReportConnection } {
  return {
    myAppBugReports: {
      reports: [
        {
          id: '42',
          comment: 'A report',
          createdAt: '2026-11-21T10:00:00Z',
          status,
          screenshotUrls: [],
          canReply: true,
        },
      ],
      hasMore: false,
      endCursor: null,
    },
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, Wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  mocks.on.mockReturnValue(mocks.removeConnected);
});

describe('owned bug-report change stream', () => {
  it('refreshes an open history list after a status change without a notification', async () => {
    mocks.request.mockResolvedValue(history('new'));
    const { client, invalidate, Wrapper } = setup();
    client.setQueryData(bugReportQueryKeys.report('account', '42'), { status: 'new' });
    client.setQueryData(bugReportQueryKeys.messages('account', '42'), { pages: [] });
    client.setQueryData(['notifications', 'unreadCount'], 1);
    const hook = renderHook(
      () => {
        useSprayCompletionUpdates(true, 'account');
        return useMyAppBugReports('account');
      },
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(hook.result.current.data?.pages[0].reports[0].status).toBe('new'));

    mocks.request.mockResolvedValue(history('resolved'));
    act(() => latestReportSink().next({ data: { appBugReportChanged: { reportId: '42' } } }));

    await waitFor(() => expect(hook.result.current.data?.pages[0].reports[0].status).toBe('resolved'));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      bugReportQueryKeys.account('account'),
      ['notifications'],
    ]);
    expect(client.getQueryState(bugReportQueryKeys.report('account', '42'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(bugReportQueryKeys.messages('account', '42'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['notifications', 'unreadCount'])?.isInvalidated).toBe(true);
    hook.unmount();
    client.clear();
  });

  it('ignores late changes from the previous account and cleans up both streams', () => {
    const { client, invalidate, Wrapper } = setup();
    const hook = renderHook(({ accountId }) => useSprayCompletionUpdates(true, accountId), {
      wrapper: Wrapper,
      initialProps: { accountId: 'first' },
    });
    const previousSink = latestReportSink();
    hook.rerender({ accountId: 'second' });
    act(() => previousSink.next({ data: { appBugReportChanged: { reportId: '42' } } }));
    expect(invalidate).not.toHaveBeenCalled();

    const currentSink = latestReportSink();
    act(() => currentSink.next({ data: { appBugReportChanged: { reportId: '17' } } }));
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      bugReportQueryKeys.account('second'),
      ['notifications'],
    ]);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(4);
    expect(mocks.removeConnected).toHaveBeenCalledTimes(2);
    invalidate.mockClear();
    act(() => currentSink.next({ data: { appBugReportChanged: { reportId: '17' } } }));
    expect(invalidate).not.toHaveBeenCalled();
    client.clear();
  });

  it('catches up missed report and bell changes when the socket reconnects', () => {
    const { client, invalidate, Wrapper } = setup();
    const hook = renderHook(() => useSprayCompletionUpdates(true, 'account'), { wrapper: Wrapper });
    const onConnected = mocks.on.mock.calls[0][1] as () => void;
    act(onConnected);
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      bugReportQueryKeys.account('account'),
      ['notifications'],
    ]);
    hook.unmount();
    invalidate.mockClear();
    act(onConnected);
    expect(invalidate).not.toHaveBeenCalled();
    client.clear();
  });

  it('waits for both authentication and an account id before subscribing to reports', () => {
    const { client, Wrapper } = setup();
    const hook = renderHook(({ authenticated, accountId }) => useSprayCompletionUpdates(authenticated, accountId), {
      wrapper: Wrapper,
      initialProps: { authenticated: false, accountId: undefined as string | undefined },
    });
    expect(mocks.subscribe).not.toHaveBeenCalled();
    hook.rerender({ authenticated: true, accountId: undefined });
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe.mock.calls[0][0].query).not.toBe(APP_BUG_REPORT_CHANGED);
    hook.rerender({ authenticated: true, accountId: 'account' });
    expect(latestReportSink()).toBeDefined();
    hook.unmount();
    client.clear();
  });
});
