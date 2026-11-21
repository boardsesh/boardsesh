// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBugReport, AppBugReportConnection, AppBugReportMessage } from '@boardsesh/shared-schema';
import { useMyAppBugReports, useRetryAppBugReportMessage, useSendAppBugReportMessage } from '../use-bug-reports';
import { bugReportQueryKeys } from '../bug-report-query-keys';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));

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
function message(): AppBugReportMessage {
  return {
    id: '101',
    reportId: '42',
    body: 'More detail',
    authorRole: 'reporter',
    deliveryStatus: 'pending',
    createdAt: '2026-11-21T10:00:00Z',
  };
}

beforeEach(() => vi.clearAllMocks());

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

  it('queues a reply and invalidates only the originating account’s report caches', async () => {
    request.mockResolvedValueOnce({ sendAppBugReportMessage: message() });
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = renderHook(() => useSendAppBugReportMessage('account', '42'), { wrapper: Wrapper });
    const input = { reportId: '42', body: 'More detail', clientMutationId: '11111111-2222-4333-8444-555555555555' };
    await act(async () => {
      await hook.result.current.mutateAsync(input);
    });
    expect(request.mock.calls[0][1]).toEqual({ input });
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      bugReportQueryKeys.messages('account', '42'),
      bugReportQueryKeys.report('account', '42'),
      bugReportQueryKeys.list('account'),
    ]);
    hook.unmount();
  });

  it('retries a persisted message by id instead of creating a new reply', async () => {
    request.mockResolvedValueOnce({ retryAppBugReportMessage: message() });
    const { Wrapper } = wrapper();
    const hook = renderHook(() => useRetryAppBugReportMessage('account', '42'), { wrapper: Wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync('101');
    });
    expect(request.mock.calls[0][1]).toEqual({ id: '101' });
    hook.unmount();
  });
});
