// @vitest-environment jsdom
//
// The cache choreography behind a vote tap. Three things here are invisible in a
// render test and wrong if written from memory:
//   - the optimistic write must reach EVERY proposal cache under the prefix, not
//     just the one list that happens to be mounted, or the pinned deep-link card
//     and the feed row behind it disagree about the same proposal;
//   - a failed request must restore the exact snapshot, not "subtract one";
//   - the server's weighted totals must overwrite the optimistic ±1, because the
//     voter's real weight (2 for a leader, 3 for an admin) is only known there.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Proposal } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { browseProposalsKey, climbProposalsKey } from '../use-browse-proposals';
import { useVoteOnProposal } from '../use-vote-on-proposal';

const BROWSE_KEY = browseProposalsKey({ boardType: null, status: 'open' });
const CLIMB_KEY = climbProposalsKey('c1');

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
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 1,
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
  queryClient.setQueryData(CLIMB_KEY, {
    climbProposals: { proposals: [proposal], totalCount: 1, hasMore: false },
  });
}

function readBrowse(queryClient: QueryClient, uuid: string): Proposal | undefined {
  const cached = queryClient.getQueryData(BROWSE_KEY) as
    | { pages: Array<{ browseProposals: { proposals: Proposal[] } }> }
    | undefined;
  return cached?.pages[0].browseProposals.proposals.find((proposal) => proposal.uuid === uuid);
}

function readClimb(queryClient: QueryClient, uuid: string): Proposal | undefined {
  const cached = queryClient.getQueryData(CLIMB_KEY) as { climbProposals: { proposals: Proposal[] } } | undefined;
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

beforeEach(() => {
  requestMock.mockReset();
});

describe('useVoteOnProposal', () => {
  it('applies the vote to every cache under the proposals prefix before the request returns', async () => {
    let settleRequest: ((value: unknown) => void) | undefined;
    requestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleRequest = resolve;
        }),
    );

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal());
    const { result } = renderHook(() => useVoteOnProposal(), { wrapper: Wrapper });

    act(() => result.current.mutate({ proposalUuid: 'p1', value: 1 }));

    await waitFor(() => expect(readBrowse(queryClient, 'p1')?.userVote).toBe(1));
    expect(readBrowse(queryClient, 'p1')?.weightedUpvotes).toBe(2);
    // The pinned deep-link card holds the same proposal in its own cache.
    expect(readClimb(queryClient, 'p1')?.userVote).toBe(1);
    // Every other row is untouched.
    expect(readBrowse(queryClient, 'other')?.userVote).toBe(0);

    settleRequest?.({ voteOnProposal: makeProposal({ userVote: 1, weightedUpvotes: 4, upvoterCount: 2 }) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('lets the server weighting overwrite the optimistic guess', async () => {
    // An admin's vote counts 3, not the 1 the optimistic step assumed.
    requestMock.mockResolvedValue({
      voteOnProposal: makeProposal({ userVote: 1, weightedUpvotes: 4, upvoterCount: 2 }),
    });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal());
    const { result } = renderHook(() => useVoteOnProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', value: 1 });
    });

    expect(readBrowse(queryClient, 'p1')).toMatchObject({ weightedUpvotes: 4, upvoterCount: 2 });
    expect(readClimb(queryClient, 'p1')).toMatchObject({ weightedUpvotes: 4, upvoterCount: 2 });
  });

  it('restores the pre-vote snapshot when the request fails', async () => {
    requestMock.mockRejectedValue(new Error('offline'));

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal({ userVote: 0, weightedUpvotes: 1 }));
    const { result } = renderHook(() => useVoteOnProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', value: 1 }).catch(() => undefined);
    });

    expect(readBrowse(queryClient, 'p1')).toMatchObject({ userVote: 0, weightedUpvotes: 1 });
    expect(readClimb(queryClient, 'p1')).toMatchObject({ userVote: 0, weightedUpvotes: 1 });
  });

  it('clears the vote when the recorded value is sent again', async () => {
    requestMock.mockResolvedValue({ voteOnProposal: makeProposal({ userVote: 0, weightedUpvotes: 1 }) });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal({ userVote: 1, weightedUpvotes: 2 }));
    const { result } = renderHook(() => useVoteOnProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', value: 1 });
    });

    expect(requestMock.mock.calls[0][1]).toEqual({ input: { proposalUuid: 'p1', value: 1 } });
    expect(readBrowse(queryClient, 'p1')).toMatchObject({ userVote: 0, weightedUpvotes: 1 });
  });
});
