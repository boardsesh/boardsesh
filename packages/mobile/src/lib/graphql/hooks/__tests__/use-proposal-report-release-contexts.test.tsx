// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useProposalReportReleaseContexts } from '../use-proposal-report-release-contexts';

const request = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ token: 'account-a-token' as string | null }));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../use-auth-token', () => ({ useAuthToken: () => ({ data: auth.token }) }));
const reports = [
  {
    commentUuid: 'comment-a',
    releaseContext: { channel: 'production', branch: 'pr-beta', automaticCanary: false },
  },
];
beforeEach(() => {
  auth.token = 'account-a-token';
  request.mockReset().mockResolvedValue({ proposalReportReleaseContexts: reports });
});

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

describe('private proposal release diagnostics cache', () => {
  it('clears diagnostic rows when the detail closes or admin access is lost', async () => {
    const { queryClient, wrapper } = setup();
    const hook = renderHook(({ enabled }) => useProposalReportReleaseContexts('proposal-a', enabled), {
      initialProps: { enabled: true },
      wrapper,
    });
    await waitFor(() => expect(hook.result.current).toEqual(reports));
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ),
    ).not.toContain(auth.token);
    hook.rerender({ enabled: false });
    expect(hook.result.current).toBeUndefined();
    expect(
      queryClient
        .getQueriesData({ queryKey: ['proposalReportReleaseContexts'] })
        .every(([, reports]) => reports === undefined),
    ).toBe(true);
    hook.unmount();
  });

  it('does not reuse another account release diagnostics', async () => {
    const { wrapper } = setup();
    const hook = renderHook(() => useProposalReportReleaseContexts('proposal-a', true), { wrapper });
    await waitFor(() => expect(hook.result.current).toEqual(reports));
    auth.token = 'account-b-token';
    request.mockResolvedValue({ proposalReportReleaseContexts: [] });
    hook.rerender();
    expect(hook.result.current).toBeUndefined();
    await waitFor(() => expect(hook.result.current).toEqual([]));
    expect(request).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('never fetches diagnostics for a signed-out viewer', () => {
    auth.token = null;
    const { wrapper } = setup();
    const hook = renderHook(() => useProposalReportReleaseContexts('proposal-a', true), { wrapper });
    expect(hook.result.current).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    hook.unmount();
  });
});
