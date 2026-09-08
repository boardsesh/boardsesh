// @vitest-environment jsdom
//
// The paging and filter arithmetic behind the moderation feed. Two things here
// are silently wrong if written from memory:
//   - the next page's offset must count proposals ALREADY HELD, not pages × 20;
//   - a null filter must be OMITTED from the input, not sent as null — a present
//     key is a filter to the resolver, and `{ status: null }` is not the same
//     request as no `status` key at all.
//
// Imports the hook file directly rather than the `hooks` barrel — the barrel
// statically reaches react-native's Flow source, which Rolldown's scan refuses.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Proposal, ProposalConnection } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import {
  browseProposalsKey,
  climbProposalsKey,
  useBrowseProposals,
  useClimbProposalsPinned,
} from '../use-browse-proposals';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

function makeProposal(uuid: string): Proposal {
  return {
    uuid,
    climbUuid: `climb-${uuid}`,
    boardType: 'kilter',
    angle: 40,
    proposerId: 'u1',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    createdAt: '2026-09-01T10:00:00.000Z',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 1,
    commentCount: 0,
  } as Proposal;
}

/** A page deliberately SHORT of the 20-row limit, so "offset += received" is
 *  distinguishable from "offset = page × 20". */
function makeConnection(count: number, hasMore: boolean): ProposalConnection {
  return {
    proposals: Array.from({ length: count }, (_, index) => makeProposal(`p-${index}`)),
    totalCount: 50,
    hasMore,
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('browseProposalsKey', () => {
  it('keys under the shared proposals prefix so one write reaches every list', () => {
    expect(browseProposalsKey({ boardType: 'kilter', status: 'open' })).toEqual([
      'proposals',
      'browse',
      { boardType: 'kilter', status: 'open' },
    ]);
  });

  it('keys the pinned climb query under the same prefix', () => {
    expect(climbProposalsKey('C1')).toEqual(['proposals', 'climb', 'C1']);
  });
});

describe('useBrowseProposals', () => {
  it('offsets the next page by the proposals already held, not by the page size', async () => {
    requestMock
      .mockResolvedValueOnce({ browseProposals: makeConnection(12, true) })
      .mockResolvedValueOnce({ browseProposals: makeConnection(8, false) });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useBrowseProposals({ boardType: null, status: 'open' }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock.mock.calls[0][1]).toEqual({ input: { limit: 20, offset: 0, status: 'open' } });

    await act(async () => {
      await result.current.fetchNextPage();
    });

    // 12 proposals came back, so the second page starts at 12 — not at 20.
    expect(requestMock.mock.calls[1][1]).toEqual({ input: { limit: 20, offset: 12, status: 'open' } });
  });

  it('omits null filters from the input entirely', async () => {
    requestMock.mockResolvedValue({ browseProposals: makeConnection(3, false) });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useBrowseProposals({ boardType: null, status: null }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const input = requestMock.mock.calls[0][1] as { input: Record<string, unknown> };
    expect(Object.keys(input.input).sort()).toEqual(['limit', 'offset']);
  });

  it('sends both filters when both are set', async () => {
    requestMock.mockResolvedValue({ browseProposals: makeConnection(3, false) });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useBrowseProposals({ boardType: 'tension', status: 'open' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock.mock.calls[0][1]).toEqual({
      input: { limit: 20, offset: 0, boardType: 'tension', status: 'open' },
    });
  });

  it('stops paginating once the server clears hasMore', async () => {
    requestMock.mockResolvedValue({ browseProposals: makeConnection(5, false) });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useBrowseProposals({ boardType: null, status: null }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('useClimbProposalsPinned', () => {
  it('stays unfired while disabled', async () => {
    const { Wrapper } = makeWrapper();
    renderHook(() => useClimbProposalsPinned({ climbUuid: 'C1', boardType: 'kilter', enabled: false }), {
      wrapper: Wrapper,
    });

    await Promise.resolve();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('stays unfired when the deep link carries no climb', async () => {
    const { Wrapper } = makeWrapper();
    renderHook(() => useClimbProposalsPinned({ climbUuid: undefined, boardType: 'kilter', enabled: true }), {
      wrapper: Wrapper,
    });

    await Promise.resolve();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('fetches one page for the climb and caches it under the climb key', async () => {
    requestMock.mockResolvedValue({ climbProposals: makeConnection(2, false) });

    const { queryClient, Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useClimbProposalsPinned({ climbUuid: 'C1', boardType: 'kilter', enabled: true }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock.mock.calls[0][1]).toEqual({ input: { climbUuid: 'C1', boardType: 'kilter', limit: 20 } });
    expect(queryClient.getQueryData(climbProposalsKey('C1'))).toBeDefined();
  });
});
