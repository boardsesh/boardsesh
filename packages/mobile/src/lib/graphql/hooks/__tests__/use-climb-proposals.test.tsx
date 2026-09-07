// @vitest-environment jsdom
//
// The play drawer's read of a climb's proposals. Three things here are contracts
// rather than implementation detail:
//   - the cache key AND the cached document shape must match the moderation
//     feed's own per-climb query, or a vote cast in the feed either misses this
//     entry or overwrites it with a shape the drawer can't read;
//   - the query runs SIGNED OUT (a hidden climb reads as hidden to everyone), so
//     it must not be gated on an auth token;
//   - callers get the proposal array, not the connection wrapper.
//
// Imports the hook file directly rather than the `hooks` barrel — the barrel
// statically reaches react-native's Flow source, which Rolldown's scan refuses
// (same reason `use-notifications.test.tsx` does).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Proposal } from '@boardsesh/shared-schema';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
// B1a owns the root key; stubbed so this suite doesn't drag the report mutation
// into a jsdom run. `use-browse-proposals` (the key builder + page size) is the
// real module, which is the point — the keys must not drift.
vi.mock('../use-report-climb', () => ({ PROPOSALS_QUERY_KEY: ['proposals'] as const }));
vi.mock('@boardsesh/graphql/operations/proposals', () => ({
  GET_CLIMB_PROPOSALS: 'GET_CLIMB_PROPOSALS',
  BROWSE_PROPOSALS: 'BROWSE_PROPOSALS',
}));

import { climbProposalsKey } from '../use-browse-proposals';
import { useClimbProposals } from '../use-climb-proposals';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const proposal = {
  uuid: 'hide-1',
  climbUuid: 'climb-1',
  boardType: 'kilter',
  angle: null,
  proposerId: 'user-1',
  type: 'hide',
  proposedValue: 'true',
  currentValue: 'false',
  status: 'open',
  reason: 'Duplicate',
  createdAt: '2026-09-01T10:00:00.000Z',
  weightedUpvotes: 2,
  weightedDownvotes: 0,
  requiredUpvotes: 5,
  userVote: 0,
  upvoterCount: 2,
  commentCount: 2,
} satisfies Proposal;

const response = { climbProposals: { proposals: [proposal], totalCount: 1, hasMore: false } };

describe('useClimbProposals', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue(response);
  });

  it('hands callers the proposal array, not the connection', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.data).toEqual([proposal]));
  });

  it('caches the raw document under the feed key, so a feed vote reaches it', async () => {
    const { queryClient, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The moderation feed's `mapCachedProposals` walks `{ climbProposals }`;
    // caching the unwrapped array here would make its rewrite a silent no-op.
    expect(queryClient.getQueryData(climbProposalsKey('climb-1'))).toEqual(response);
    expect(climbProposalsKey('climb-1')).toEqual(['proposals', 'climb', 'climb-1']);
  });

  it('asks for the climb, the board and one page', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: 'climb-1', boardType: 'tension' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledWith('GET_CLIMB_PROPOSALS', {
      input: { climbUuid: 'climb-1', boardType: 'tension', limit: 20 },
    });
  });

  it('stays idle when the caller disables it (kill flag off)', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter', enabled: false }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does not fire without a climb uuid', async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useClimbProposals({ climbUuid: '', boardType: 'kilter' }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(requestMock).not.toHaveBeenCalled();
  });
});
