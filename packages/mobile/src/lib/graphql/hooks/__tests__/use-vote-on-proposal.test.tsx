// @vitest-environment jsdom
//
// The cache choreography behind a vote tap. Four things here are invisible in a
// render test and wrong if written from memory:
//   - the optimistic write must reach EVERY proposal cache under the prefix, not
//     just the one list that happens to be mounted, or the pinned deep-link card
//     and the feed row behind it disagree about the same proposal;
//   - a failed request must put back the failed proposal ALONE — restoring a
//     whole-cache snapshot erases a sibling card's vote that landed meanwhile;
//   - a vote that carries the proposal past its threshold resolves it
//     server-side, which changes the CLIMB, so it has to bust the climb reads
//     exactly like a moderator's verdict does;
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
import { CLIMB_EFFECT_QUERY_KEYS } from '../proposal-cache';
import { PROPOSALS_QUERY_KEY } from '../use-report-climb';
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

/** Record the keys handed to `invalidateQueries` without firing any refetch. */
function watchInvalidations(queryClient: QueryClient) {
  const keys: unknown[] = [];
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => {
    keys.push(filters?.queryKey);
  });
  return keys;
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

  it('restores the pre-vote row when the request fails', async () => {
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

  it('rolls back the failed proposal alone, so a sibling vote that landed survives', async () => {
    // Two taps overlap — that is what a moderation pass looks like. The first
    // one's request is still in flight when the second lands, so a rollback that
    // restored a snapshot of every proposal cache would paint the sibling's
    // pre-vote row back over the vote the server had already accepted.
    let failFirstVote: ((reason: unknown) => void) | undefined;
    requestMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirstVote = reject;
          }),
      )
      .mockResolvedValueOnce({
        voteOnProposal: makeProposal({ uuid: 'other', userVote: 1, weightedUpvotes: 4, upvoterCount: 2 }),
      });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal({ userVote: 0, weightedUpvotes: 1 }));
    const { result } = renderHook(() => ({ failing: useVoteOnProposal(), landing: useVoteOnProposal() }), {
      wrapper: Wrapper,
    });

    act(() => result.current.failing.mutate({ proposalUuid: 'p1', value: 1 }));
    await waitFor(() => expect(readBrowse(queryClient, 'p1')?.userVote).toBe(1));

    await act(async () => {
      await result.current.landing.mutateAsync({ proposalUuid: 'other', value: 1 });
    });
    expect(readBrowse(queryClient, 'other')).toMatchObject({ userVote: 1, weightedUpvotes: 4 });

    failFirstVote?.(new Error('offline'));
    await waitFor(() => expect(result.current.failing.isError).toBe(true));

    // The failed row is back where it started...
    expect(readBrowse(queryClient, 'p1')).toMatchObject({ userVote: 0, weightedUpvotes: 1 });
    expect(readClimb(queryClient, 'p1')).toMatchObject({ userVote: 0, weightedUpvotes: 1 });
    // ...and the vote that succeeded on the card next to it is untouched.
    expect(readBrowse(queryClient, 'other')).toMatchObject({ userVote: 1, weightedUpvotes: 4 });
  });

  it('sends the failed proposal back to the server rather than trusting the pre-image', async () => {
    // The pre-image is one screen's idea of the row and other people have been
    // voting on it since, so the rollback is a placeholder until the refetch.
    requestMock.mockRejectedValue(new Error('offline'));

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal());
    const invalidated = watchInvalidations(queryClient);
    const { result } = renderHook(() => useVoteOnProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', value: 1 }).catch(() => undefined);
    });

    expect(invalidated).toContainEqual([...PROPOSALS_QUERY_KEY]);
  });

  it('busts the climb reads when the vote carries the proposal', async () => {
    // Past the threshold the backend applies the effect and hands back a
    // proposal that is no longer open: the climb itself has changed, so every
    // list still holding the old row has to go and ask again.
    requestMock.mockResolvedValue({
      voteOnProposal: makeProposal({ status: 'approved', userVote: 1, weightedUpvotes: 3, upvoterCount: 3 }),
    });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal());
    const invalidated = watchInvalidations(queryClient);
    const { result } = renderHook(() => useVoteOnProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', value: 1 });
    });

    expect(invalidated).toContainEqual([...PROPOSALS_QUERY_KEY]);
    for (const queryKey of CLIMB_EFFECT_QUERY_KEYS) {
      expect(invalidated).toContainEqual([...queryKey]);
    }
    // Spelled out as well as looped: the loop above would still pass if the
    // shared constants drifted to keys nothing reads.
    expect(invalidated).toContainEqual(['climb']);
    expect(invalidated).toContainEqual(['searchClimbs']);
    expect(invalidated).toContainEqual(['infiniteSearchClimbs']);
    expect(invalidated).toContainEqual(['searchClimbsCount']);
  });

  it('leaves the climb reads alone while the proposal is still open', async () => {
    // The common case: a vote that moves the bar and nothing else. Busting the
    // search caches on every tap would refetch the whole list a dozen times in a
    // moderation pass.
    requestMock.mockResolvedValue({ voteOnProposal: makeProposal({ userVote: 1, weightedUpvotes: 2 }) });

    const { queryClient, Wrapper } = makeWrapper();
    seedCaches(queryClient, makeProposal());
    const invalidated = watchInvalidations(queryClient);
    const { result } = renderHook(() => useVoteOnProposal(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ proposalUuid: 'p1', value: 1 });
    });

    expect(invalidated).toEqual([]);
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
