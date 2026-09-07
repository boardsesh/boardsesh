// @vitest-environment jsdom
//
// The cache choreography behind a moderator's verdict. Resolving has no
// optimistic step — it APPLIES the change server-side — so the ordering is what
// matters and it is invisible in a render test:
//   - the server's row must land in every proposal cache BEFORE the
//     invalidations fire, or the card flashes back to an open proposal while the
//     refetch is in flight;
//   - the proposals prefix AND every climb read must be invalidated — the detail
//     query and all three search caches — because an approved hide flips
//     `is_hidden` on a climb the lists are still holding;
//   - a failed request must leave the caches exactly as they were (there is
//     nothing optimistic to roll back, so a write here would be a lie), tell
//     the moderator, and refetch — the hook owns that, not the call site, so
//     an unmounted card cannot swallow the error.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RESOLVE_PROPOSAL_FEED } from '@boardsesh/graphql/operations/proposals';
import type { Proposal } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: showToastMock }) }));

import { browseProposalsKey, climbProposalsKey } from '../use-browse-proposals';
import { CLIMB_EFFECT_QUERY_KEYS } from '../proposal-cache';
import { PROPOSALS_QUERY_KEY } from '../use-report-climb';
import { useResolveProposal } from '../use-resolve-proposal';

const BROWSE_KEY = browseProposalsKey({ boardType: null, status: 'open' });
const CLIMB_PROPOSALS_KEY = climbProposalsKey('c1');

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
  showToastMock.mockReset();
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

    // The proposal lists AND every climb read: an approved hide flips
    // `is_hidden`, so the open detail AND the search lists behind the card — the
    // paged one, the infinite one, and the count in the filter bar — all have to
    // go and ask again.
    expect(invalidations.keys).toContainEqual([...PROPOSALS_QUERY_KEY]);
    for (const queryKey of CLIMB_EFFECT_QUERY_KEYS) {
      expect(invalidations.keys).toContainEqual([...queryKey]);
    }
    expect(invalidations.keys).toContainEqual(['climb']);
    expect(invalidations.keys).toContainEqual(['searchClimbs']);
    expect(invalidations.keys).toContainEqual(['infiniteSearchClimbs']);
    expect(invalidations.keys).toContainEqual(['searchClimbsCount']);
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

  it('rejects, toasts, and refetches instead of writing anything when the request fails', async () => {
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
    // The hook itself tells the moderator and pulls the current row, without
    // the caller having to pass an `onError`.
    expect(showToastMock).toHaveBeenCalledWith('mobile.moderation.resolveError', 'error');
    expect(invalidations.keys).toEqual([PROPOSALS_QUERY_KEY]);
  });

  it('does not toast on success', async () => {
    requestMock.mockResolvedValue({ resolveProposal: makeProposal({ status: 'approved' }) });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal({ status: 'open' }));
    watchInvalidations(queryClient);
    const { result } = renderHook(() => useResolveProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', status: 'approved' });
    });

    expect(showToastMock).not.toHaveBeenCalled();
  });
});
