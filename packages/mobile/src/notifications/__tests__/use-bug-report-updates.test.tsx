// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBugReport, AppBugReportConnection } from '@boardsesh/shared-schema';
import { APP_BUG_REPORT, APP_BUG_REPORT_CHANGED, APP_BUG_REPORT_MESSAGES } from '@boardsesh/graphql/operations';
import { NOTIFICATION_RECEIVED_SUBSCRIPTION } from '@boardsesh/graphql/operations/notifications';
import { useSprayCompletionUpdates } from '../use-spray-completion-updates';
import { useAppBugReport, useAppBugReportMessages, useMyAppBugReports } from '../../lib/feedback/use-bug-reports';
import { bugReportQueryKeys } from '../../lib/feedback/bug-report-query-keys';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  on: vi.fn(),
  removeConnected: vi.fn(),
  getWsClient: vi.fn(),
  listenDisposed: vi.fn(),
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 0,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: mocks.getWsClient }));
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ offlineMode: false }),
  subscribeConnectivity: () => () => {},
}));
vi.mock('../../lib/graphql/ws-client-lifecycle', () => ({ subscribeWsClientDisposed: mocks.listenDisposed }));

type ReportSink = { next: (payload: { data: { appBugReportChanged: { reportId: string } } }) => void };
type NotificationSink = {
  next: (payload: { data: { notificationReceived: { notification: { type: string; entityId: string } } } }) => void;
};
function latestReportSink(): ReportSink {
  const subscription = mocks.subscribe.mock.calls.findLast(([operation]) => operation.query === APP_BUG_REPORT_CHANGED);
  if (!subscription) throw new Error('Missing report-change subscription');
  return subscription[1] as ReportSink;
}
function emitReportChange(reportId = '42') {
  latestReportSink().next({ data: { appBugReportChanged: { reportId } } });
}
function report(id = '42', status: AppBugReport['status'] = 'new'): AppBugReport {
  return { id, comment: 'A report', createdAt: '2026-11-21T10:00:00Z', status, screenshotUrls: [], canReply: true };
}
function history(status: AppBugReport['status'] = 'new'): { myAppBugReports: AppBugReportConnection } {
  return { myAppBugReports: { reports: [report('42', status)], hasMore: false, endCursor: null } };
}
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, Wrapper };
}
async function advance(milliseconds = 201) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  focusManager.setFocused(true);
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  mocks.on.mockReturnValue(mocks.removeConnected);
  mocks.getWsClient.mockReturnValue({ subscribe: mocks.subscribe, on: mocks.on });
  mocks.listenDisposed.mockReturnValue(() => {});
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('owned bug-report change stream', () => {
  it('refreshes visible history after a status change without a notification', async () => {
    mocks.request.mockResolvedValue(history());
    const { client, invalidate, Wrapper } = setup();
    client.setQueryData(bugReportQueryKeys.report('account', '42'), report());
    client.setQueryData(bugReportQueryKeys.messages('account', '42'), { pages: [] });
    client.setQueryData(['notifications', 'unreadCount'], 1);
    const hook = renderHook(
      () => {
        useSprayCompletionUpdates(true, 'account');
        return useMyAppBugReports('account');
      },
      { wrapper: Wrapper },
    );
    await advance(0);
    expect(hook.result.current.data?.pages[0].reports[0].status).toBe('new');
    mocks.request.mockResolvedValue(history('resolved'));
    act(() => emitReportChange());
    await advance();
    expect(hook.result.current.data?.pages[0].reports[0].status).toBe('resolved');
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      bugReportQueryKeys.list('account'),
      bugReportQueryKeys.report('account', '42'),
      bugReportQueryKeys.messages('account', '42'),
      ['notifications'],
    ]);
    expect(client.getQueryState(bugReportQueryKeys.report('account', '42'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(bugReportQueryKeys.messages('account', '42'))?.isInvalidated).toBe(true);
  });

  it('coalesces duplicate report and staff events without reading hidden history or unrelated conversations', async () => {
    const { client, Wrapper } = setup();
    const historyPages = [history().myAppBugReports, history().myAppBugReports, history().myAppBugReports];
    client.setQueryData(bugReportQueryKeys.list('account'), { pages: historyPages, pageParams: [null, '42', '17'] });
    mocks.request.mockImplementation((operation: unknown, variables: { id?: string }) => {
      if (operation === APP_BUG_REPORT) return Promise.resolve({ appBugReport: report(variables.id) });
      if (operation === APP_BUG_REPORT_MESSAGES)
        return Promise.resolve({ appBugReportMessages: { messages: [], hasMore: false, endCursor: null } });
      throw new Error('Unexpected history fetch');
    });
    renderHook(
      () => {
        useSprayCompletionUpdates(true, 'account');
        useMyAppBugReports('account', false);
        useAppBugReport('account', '42');
        useAppBugReportMessages('account', '42', true);
        useAppBugReport('account', '17');
        useAppBugReportMessages('account', '17', true);
      },
      { wrapper: Wrapper },
    );
    await advance(0);
    expect(mocks.request).toHaveBeenCalledTimes(4);
    mocks.request.mockClear();
    const notificationSink = mocks.subscribe.mock.calls.find(
      ([operation]) => operation.query === NOTIFICATION_RECEIVED_SUBSCRIPTION,
    )?.[1] as NotificationSink;
    act(() => {
      emitReportChange();
      emitReportChange();
      notificationSink.next({
        data: { notificationReceived: { notification: { type: 'app_feedback_reply', entityId: '42' } } },
      });
    });
    await advance();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls.map(([operation]) => operation)).toEqual([APP_BUG_REPORT, APP_BUG_REPORT_MESSAGES]);
    expect(mocks.request.mock.calls[0][1]).toEqual({ id: '42' });
    expect(mocks.request.mock.calls[1][1]).toMatchObject({ input: { reportId: '42' } });
    expect(client.getQueryData(bugReportQueryKeys.list('account'))).toEqual({
      pages: historyPages,
      pageParams: [null, '42', '17'],
    });
    expect(client.getQueryState(bugReportQueryKeys.list('account'))?.isInvalidated).toBe(true);
    await advance(60_000);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('retains a trailing event while the first refresh is waiting on a response', async () => {
    const { Wrapper } = setup();
    mocks.request.mockResolvedValue({ appBugReport: report() });
    const hook = renderHook(
      () => {
        useSprayCompletionUpdates(true, 'account');
        return useAppBugReport('account', '42');
      },
      { wrapper: Wrapper },
    );
    await advance(0);
    let resolveFirst: ((response: { appBugReport: AppBugReport }) => void) | undefined;
    mocks.request.mockClear();
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise<{ appBugReport: AppBugReport }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ appBugReport: report('42', 'resolved') });
    act(() => emitReportChange());
    await advance();
    expect(mocks.request).toHaveBeenCalledOnce();
    act(() => emitReportChange());
    await act(async () => resolveFirst?.({ appBugReport: report() }));
    await advance();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(hook.result.current.data?.status).toBe('resolved');
  });

  it('waits for a pre-event read and reconciles once without cancelling it', async () => {
    let resolveInitial: ((response: { appBugReport: AppBugReport }) => void) | undefined;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise<{ appBugReport: AppBugReport }>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValue({ appBugReport: report('42', 'resolved') });
    const { Wrapper } = setup();
    const hook = renderHook(
      () => {
        useSprayCompletionUpdates(true, 'account');
        return useAppBugReport('account', '42');
      },
      { wrapper: Wrapper },
    );
    act(() => emitReportChange());
    await advance();
    expect(mocks.request).toHaveBeenCalledOnce();
    await act(async () => resolveInitial?.({ appBugReport: report() }));
    await advance(0);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(hook.result.current.data?.status).toBe('resolved');
  });

  it('cancels queued old-account work and ignores late events after account change or unmount', async () => {
    const { invalidate, Wrapper } = setup();
    const hook = renderHook(({ accountId }) => useSprayCompletionUpdates(true, accountId), {
      wrapper: Wrapper,
      initialProps: { accountId: 'first' },
    });
    const previousSink = latestReportSink();
    act(() => emitReportChange());
    hook.rerender({ accountId: 'second' });
    act(() => previousSink.next({ data: { appBugReportChanged: { reportId: '42' } } }));
    const currentSink = latestReportSink();
    act(() => emitReportChange('17'));
    await advance();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      bugReportQueryKeys.list('second'),
      bugReportQueryKeys.report('second', '17'),
      bugReportQueryKeys.messages('second', '17'),
      ['notifications'],
    ]);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(4);
    expect(mocks.removeConnected).toHaveBeenCalledTimes(2);
    invalidate.mockClear();
    act(() => currentSink.next({ data: { appBugReportChanged: { reportId: '17' } } }));
    await advance();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('drops queued changes and ignores its old socket after disposal', async () => {
    const { invalidate, Wrapper } = setup();
    renderHook(() => useSprayCompletionUpdates(true, 'account'), { wrapper: Wrapper });
    const sink = latestReportSink();
    const disposed = mocks.listenDisposed.mock.calls[0][0] as (client: unknown) => void;
    act(() => {
      emitReportChange();
      disposed(mocks.getWsClient.mock.results[0].value);
      sink.next({ data: { appBugReportChanged: { reportId: '42' } } });
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await advance();
    expect(invalidate).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('coalesces reconnect and foreground catch-up without refreshing spray caches', async () => {
    const { invalidate, Wrapper } = setup();
    const hook = renderHook(() => useSprayCompletionUpdates(true, 'account'), { wrapper: Wrapper });
    const connected = mocks.on.mock.calls[0][1] as () => void;
    act(() => {
      connected();
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await advance();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      bugReportQueryKeys.account('account'),
      ['notifications'],
    ]);
    hook.unmount();
    invalidate.mockClear();
    act(connected);
    await advance();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('waits for authentication and an account id before subscribing to reports', () => {
    const { Wrapper } = setup();
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
  });
});
