// @vitest-environment jsdom
//
// The two things `useReportClimb` owes its callers, neither visible in a render
// test: it posts the shared REPORT_CLIMB document with the input verbatim, and a
// landed report invalidates the proposal lists (the moderation feed reads
// `['proposals']`) plus the climb detail, whose `is_hidden` the report can flip.
//
// Imports the hook file directly rather than the `hooks` barrel — the barrel
// statically reaches react-native's Flow source, which Rolldown's scan refuses
// (same reason `use-notifications.test.tsx` does).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { REPORT_CLIMB } from '@boardsesh/graphql/operations/proposals';
import type { ReportClimbInput } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { PROPOSALS_QUERY_KEY, useReportClimb } from '../use-report-climb';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const hideInput: ReportClimbInput = {
  climbUuid: 'climb-1',
  boardType: 'kilter',
  angle: null,
  kind: 'hide',
  reason: 'Duplicate of another climb on this board',
};

const reportResult = {
  reportClimb: {
    status: 'created',
    proposal: { uuid: 'proposal-1', weightedUpvotes: 1, requiredUpvotes: 5 },
  },
};

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue(reportResult);
});

describe('useReportClimb', () => {
  it('posts REPORT_CLIMB with the input and unwraps the result', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useReportClimb(), { wrapper: Wrapper });

    result.current.mutate({ input: hideInput });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledWith(REPORT_CLIMB, { input: hideInput });
    expect(result.current.data).toEqual(reportResult.reportClimb);
  });

  it('invalidates the proposal lists and the climb detail once a report lands', async () => {
    const { queryClient, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useReportClimb(), { wrapper: Wrapper });

    result.current.mutate({ input: hideInput });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The prefix, not a fully-qualified key: the moderation feed and the
    // per-climb proposal queries all key under it.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: PROPOSALS_QUERY_KEY });
    expect(PROPOSALS_QUERY_KEY).toEqual(['proposals']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['climb'] });
  });

  it('leaves a rejection to the caller — nothing is invalidated', async () => {
    const { queryClient, Wrapper } = makeWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    requestMock.mockRejectedValue(new Error('Climb is already hidden'));
    const { result } = renderHook(() => useReportClimb(), { wrapper: Wrapper });

    result.current.mutate({ input: hideInput });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
