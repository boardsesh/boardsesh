// @vitest-environment jsdom
//
// The cache choreography behind a moderator's verdict. Resolving has no
// optimistic step — it APPLIES the change server-side — so the ordering is what
// matters and it is invisible in a render test:
//   - the server's row must land in every proposal cache BEFORE the
//     invalidations fire, or the card flashes back to an open proposal while the
//     refetch is in flight;
//   - both the proposals prefix and the climb query must be invalidated, because
//     an approved hide flips `is_hidden` on a climb the lists still hold;
//   - a failed request must leave the caches exactly as they were: there is
//     nothing optimistic to roll back, so a write here would be a lie.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RESOLVE_PROPOSAL_FEED } from '@boardsesh/graphql/operations/proposals';
import type { Proposal } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { browseProposalsKey, climbProposalsKey } from '../use-browse-proposals';
import { PROPOSALS_QUERY_KEY } from '../use-report-climb';
import { useResolveProposal } from '../use-resolve-proposal';

const BROWSE_KEY = browseProposalsKey({ boardType: null, status: 'open' });
const CLIMB_PROPOSALS_KEY = climbProposalsKey('c1');
/** The key `useClimb` writes under — private to the hook, restated here. */
const CLIMB_QUERY_KEY = ['climb'];

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    uuid: 'p1',
    climbUuid: 'c1',
    boardType: 'kilter',
    angle: 40,
    proposerId: 'u1',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    createdAt: '2026-09-01T10:00:00.000Z',
    weightedUpvotes: 3,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 3,
    commentCount: 0,
    ...overrides,
  } as Proposal;
}

function seedCaches(queryClient: QueryClient, proposal: Proposal) {
  const proposals = [proposal, makeProposal({ uuid: 'other' })];
  queryClient.setQueryData(BROWSE_KEY, {
    pages: [{ browseProposals: { proposals, totalCount: 2, hasMore: false } }],
    pageParams: [0],
  });
  queryClient.setQueryData(CLIMB_PROPOSALS_KEY, {
    climbProposals: { proposals: [proposal], totalCount: 1, hasMore: false },
  });
}

function readBrowse(queryClient: QueryClient, uuid: string): Proposal | undefined {
  const cached = queryClient.getQueryData(BROWSE_KEY) as
    | { pages: Array<{ browseProposals: { proposals: Proposal[] } }> }
    | undefined;
  return cached?.pages[0].browseProposals.proposals.find((proposal) => proposal.uuid === uuid);
}

function readClimbProposals(queryClient: QueryClient, uuid: string): Proposal | undefined {
  const cached = queryClient.getQueryData(CLIMB_PROPOSALS_KEY) as
    | { climbProposals: { proposals: Proposal[] } }
    | undefined;
  return cached?.climbProposals.proposals.find((proposal) => proposal.uuid === uuid);
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

/**
 * Stand in for `invalidateQueries` so the test can see WHEN it ran, not only
 * that it ran: every call records the key it was handed, and the first one also
 * snapshots the browse cache. If the write came second, that snapshot still
 * holds the open proposal.
 */
function watchInvalidations(queryClient: QueryClient) {
  const keys: unknown[] = [];
  let browseAtFirstInvalidation: Proposal | undefined;
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => {
    keys.push(filters?.queryKey);
    if (keys.length === 1) browseAtFirstInvalidation = readBrowse(queryClient, 'p1');
  });
  return {
    keys,
    firstInvalidationSawBrowse: () => browseAtFirstInvalidation,
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useResolveProposal', () => {
  it('writes the resolved proposal into every cache BEFORE invalidating', async () => {
    const resolved = makeProposal({ status: 'approved' });
    requestMock.mockResolvedValue({ resolveProposal: resolved });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal({ status: 'open' }));
    const invalidations = watchInvalidations(queryClient);
    const { result } = renderHook(() => useResolveProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', status: 'approved' });
    });

    // The card keeps its resolved chip through the refetch instead of flashing
    // back to an open one.
    expect(invalidations.firstInvalidationSawBrowse()).toMatchObject({ uuid: 'p1', status: 'approved' });
    expect(readBrowse(queryClient, 'p1')).toMatchObject({ status: 'approved' });
    // The pinned deep-link card holds the same proposal in its own cache.
    expect(readClimbProposals(queryClient, 'p1')).toMatchObject({ status: 'approved' });
    // Every other row is untouched.
    expect(readBrowse(queryClient, 'other')).toMatchObject({ status: 'open' });

    // The proposal lists AND the climb: an approved hide flips `is_hidden`, so a
    // list still holding the climb has to go and ask again.
    expect(invalidations.keys).toContainEqual([...PROPOSALS_QUERY_KEY]);
    expect(invalidations.keys).toContainEqual(CLIMB_QUERY_KEY);
  });

  it('posts the resolve mutation with the proposal uuid and the verdict', async () => {
    requestMock.mockResolvedValue({ resolveProposal: makeProposal({ status: 'rejected' }) });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal({ status: 'open' }));
    watchInvalidations(queryClient);
    const { result } = renderHook(() => useResolveProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', status: 'rejected' });
    });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(RESOLVE_PROPOSAL_FEED, {
      input: { proposalUuid: 'p1', status: 'rejected' },
    });
  });

  it('rejects and leaves the caches untouched when the request fails', async () => {
    requestMock.mockRejectedValue(new Error('offline'));

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal({ status: 'open' }));
    const invalidations = watchInvalidations(queryClient);
    const { result } = renderHook(() => useResolveProposal(), { wrapper: Wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ proposalUuid: 'p1', status: 'approved' })).rejects.toThrow('offline');
    });

    // Nothing optimistic went in, so nothing needs rolling back — and nothing
    // may have been written either.
    expect(readBrowse(queryClient, 'p1')).toMatchObject({ status: 'open' });
    expect(readClimbProposals(queryClient, 'p1')).toMatchObject({ status: 'open' });
    expect(invalidations.keys).toHaveLength(0);
  });
});
