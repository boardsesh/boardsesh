// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { GET_BULK_VOTE_SUMMARIES } from '@boardsesh/graphql/operations';
import type { VoteSummary } from '@boardsesh/shared-schema';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { VoteSummaryProvider, useVoteSummaryContext } from '../vote-summary-context';

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);

function makeVoteSummary(entityId: string): VoteSummary {
  return { entityType: 'tick', entityId, upvotes: 1, downvotes: 0, voteScore: 1, userVote: 0 };
}

function makeWrapper(entityIds: string[]) {
  const queryClient = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <VoteSummaryProvider entityType="tick" entityIds={entityIds}>
        {children}
      </VoteSummaryProvider>
    </QueryClientProvider>
  );
  return Wrapper;
}

beforeEach(() => {
  mockRequest.mockReset();
  mockUseWsAuthToken.mockReturnValue({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null });
});

// Regression coverage for #4102: any of the seven VoteSummaryProvider call
// sites (logbook, feeds, session detail) can pass more than 100 entity ids,
// which the backend's BulkVoteSummaryInputSchema rejects outright
// (`.max(100)`). The provider must chunk internally so no single request
// ever exceeds the cap, and callers no longer need to slice their own lists.
describe('VoteSummaryProvider', () => {
  it('splits entity ids over the backend 100-ID cap into multiple <=100-ID requests', async () => {
    const entityIds = Array.from({ length: 135 }, (_, index) => `tick-${String(index).padStart(3, '0')}`);
    mockRequest.mockImplementation((_query: unknown, variables: { input: { entityIds: string[] } }) =>
      Promise.resolve({
        bulkVoteSummaries: variables.input.entityIds.map((entityId) => makeVoteSummary(entityId)),
      }),
    );

    const { result } = renderHook(() => useVoteSummaryContext(), { wrapper: makeWrapper(entityIds) });

    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
    for (const [query, variables] of mockRequest.mock.calls as [unknown, { input: { entityIds: string[] } }][]) {
      expect(query).toBe(GET_BULK_VOTE_SUMMARIES);
      expect(variables.input.entityIds.length).toBeLessThanOrEqual(100);
    }

    await waitFor(() => expect(result.current?.getVoteSummary('tick-000')).toBeDefined());
    expect(result.current?.getVoteSummary('tick-134')).toBeDefined();
  });

  it("keeps a resolved chunk's summaries available when a sibling chunk's request fails", async () => {
    const entityIds = Array.from({ length: 135 }, (_, index) => `tick-${String(index).padStart(3, '0')}`);
    mockRequest.mockImplementation((_query: unknown, variables: { input: { entityIds: string[] } }) => {
      // The second chunk (ids 100-134) fails; the first chunk (0-99) resolves.
      if (variables.input.entityIds.includes('tick-100')) {
        return Promise.reject(new Error('chunk 2 failed'));
      }
      return Promise.resolve({
        bulkVoteSummaries: variables.input.entityIds.map((entityId) => makeVoteSummary(entityId)),
      });
    });

    const { result } = renderHook(() => useVoteSummaryContext(), { wrapper: makeWrapper(entityIds) });

    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current?.getVoteSummary('tick-000')).toBeDefined());

    expect(result.current?.getVoteSummary('tick-099')).toBeDefined();
    // The failed chunk's rows are simply absent, not blanking the rows that did load.
    expect(result.current?.getVoteSummary('tick-100')).toBeUndefined();
  });

  // The provider wraps surfaces with 100+ VoteButtons, and every one of them
  // re-renders whenever the context value changes identity. `useQueries` only
  // holds identity when it is given a `combine` — see combineVoteSummaryChunks
  // in vote-summary-context.tsx.
  it('holds the context value identity across provider re-renders, so VoteButtons do not re-render', async () => {
    const entityIds = Array.from({ length: 135 }, (_, index) => `tick-${String(index).padStart(3, '0')}`);
    mockRequest.mockImplementation((_query: unknown, variables: { input: { entityIds: string[] } }) =>
      Promise.resolve({
        bulkVoteSummaries: variables.input.entityIds.map((entityId) => makeVoteSummary(entityId)),
      }),
    );
    const queryClient = createTestQueryClient();
    // A fresh array on every provider render, the way a caller passing
    // `ticks.map((tick) => tick.uuid)` inline would.
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <VoteSummaryProvider entityType="tick" entityIds={[...entityIds]}>
          {children}
        </VoteSummaryProvider>
      </QueryClientProvider>
    );

    const { result, rerender } = renderHook(() => useVoteSummaryContext(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current?.getVoteSummary('tick-134')).toBeDefined());
    const settledValue = result.current;

    rerender();
    rerender();

    expect(result.current).toBe(settledValue);
  });
});
