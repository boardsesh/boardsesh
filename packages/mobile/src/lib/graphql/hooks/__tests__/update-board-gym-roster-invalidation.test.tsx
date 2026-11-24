// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { gymReportingQueryKey } from '@boardsesh/graphql';
import { gymClimbRankingsQueryKey } from '@boardsesh/board-react';
import { getGymRankingRetirementGeneration } from '../../../privacy/privacy-cache';
import { gymBoardsQueryKey } from '../../query-keys';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request }) }));
// The hooks barrel re-exports siblings that transitively pull in react-native /
// expo-router. usePinBoard is pure React Query and touches none of them, so stub
// the heavy re-exports so the barrel parses under the node SSR transform.
vi.mock('react-native', () => ({}));
// The barrel reaches the sync adapter; pin ordering does not use native credentials.
vi.mock('../../../auth-store', () => ({
  getAuthToken: async () => null,
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
vi.mock('../use-similar-climbs', () => ({ useSimilarClimbs: vi.fn() }));
vi.mock('../use-beta-link-preview', () => ({ useBetaLinkPreview: vi.fn() }));
vi.mock('../use-mobile-climb-actions-data', () => ({ useMobileClimbActionsData: vi.fn() }));
vi.mock('../use-you-data', () => ({
  useAllBoardsTicks: vi.fn(),
  useUserProfileStats: vi.fn(),
  useUserClimbPercentile: vi.fn(),
  useUserAscentsFeed: vi.fn(),
  useSessionGroupedFeed: vi.fn(),
}));
vi.mock('../use-you-profile-data', () => ({ useYouProfileData: vi.fn() }));
vi.mock('../use-social', () => ({
  useVote: vi.fn(),
  useBulkVoteSummaries: vi.fn(),
  useComments: vi.fn(),
  useAddComment: vi.fn(),
}));
vi.mock('../use-session-detail', () => ({ useSessionDetail: vi.fn(), useSessionPreview: vi.fn() }));
vi.mock('../use-delete-account', () => ({ useDeleteAccountInfo: vi.fn(), useDeleteAccount: vi.fn() }));
vi.mock('../use-integrations', () => ({
  useIntegrationStatuses: vi.fn(),
  useDisconnectIntegration: vi.fn(),
  useSetIntegrationAutoSync: vi.fn(),
  useSyncSessionToIntegration: vi.fn(),
}));

import { useDetachBoardFromGym, useRequestGymClaim, useUpdateBoard, useUpdateSprayWall } from '../index';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(gymBoardsQueryKey('gym-1'), { gymBoards: [] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('board edits refresh the gym roster', () => {
  const removalError = new Error('Board removal did not commit');

  it.each([
    { name: 'committed', outcome: true },
    { name: 'false', outcome: false },
    { name: 'rejected', outcome: removalError },
  ])('retires the gym reports and copied player only when detach commits ($name)', async ({ outcome }) => {
    if (outcome instanceof Error) request.mockRejectedValueOnce(outcome);
    else request.mockResolvedValueOnce({ detachBoardFromGym: outcome });

    const { client, wrapper } = setup();
    const report = gymReportingQueryKey('viewer-1', 'gym-1', 'board-1', 'week');
    const otherReport = gymReportingQueryKey('viewer-1', 'gym-2', null, 'week');
    const rankings = gymClimbRankingsQueryKey(
      'viewer-1',
      1,
      { gymUuid: 'gym-1', boardUuid: 'board-1', period: 'week', mode: 'MOST_SENT' },
      1,
    );
    const otherRankings = gymClimbRankingsQueryKey(
      'viewer-1',
      1,
      { gymUuid: 'gym-2', period: 'week', mode: 'MOST_SENT' },
      1,
    );
    const reportReceipt = { boards: ['board-1'] };
    const rankingReceipt = { rows: ['climb-1'] };
    const otherReportReceipt = { boards: ['board-2'] };
    const otherRankingReceipt = { rows: ['climb-2'] };
    client.setQueryData(report, reportReceipt);
    client.setQueryData(rankings, rankingReceipt);
    client.setQueryData(otherReport, otherReportReceipt);
    client.setQueryData(otherRankings, otherRankingReceipt);
    const generation = getGymRankingRetirementGeneration();
    const { result } = renderHook(() => useDetachBoardFromGym(), { wrapper });
    await act(async () => {
      const detach = result.current.mutateAsync({ gymUuid: 'gym-1', boardUuid: 'board-1' });
      if (outcome instanceof Error) await expect(detach).rejects.toBe(outcome);
      else await expect(detach).resolves.toBe(outcome);
    });

    const retired = outcome === true;
    expect(client.getQueryData(report)).toEqual(retired ? undefined : reportReceipt);
    expect(client.getQueryData(rankings)).toEqual(retired ? undefined : rankingReceipt);
    expect(client.getQueryData(otherReport)).toEqual(otherReportReceipt);
    expect(client.getQueryData(otherRankings)).toEqual(otherRankingReceipt);
    expect(getGymRankingRetirementGeneration() - generation).toBe(retired ? 1 : 0);
  });

  it('useUpdateBoard invalidates the cached gym roster', async () => {
    request.mockResolvedValueOnce({ updateBoard: { uuid: 'b1' } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUpdateBoard(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ boardUuid: 'b1' } as never);
    });
    await waitFor(() => expect(client.getQueryState(gymBoardsQueryKey('gym-1'))?.isInvalidated).toBe(true));
  });

  it('useUpdateSprayWall invalidates the cached gym roster', async () => {
    request.mockResolvedValueOnce({ updateSprayWall: { uuid: 'w1', layoutId: 5 } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUpdateSprayWall(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ uuid: 'w1' } as never);
    });
    await waitFor(() => expect(client.getQueryState(gymBoardsQueryKey('gym-1'))?.isInvalidated).toBe(true));
  });

  it('an approved gym claim invalidates the cached gym roster', async () => {
    request.mockResolvedValueOnce({ requestGymClaim: { status: 'approved' } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useRequestGymClaim(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ gymUuid: 'gym-1' } as never);
    });
    await waitFor(() => expect(client.getQueryState(gymBoardsQueryKey('gym-1'))?.isInvalidated).toBe(true));
  });

  it('a claim sent for review leaves the roster alone', async () => {
    request.mockResolvedValueOnce({ requestGymClaim: { status: 'admin_review' } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useRequestGymClaim(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ gymUuid: 'gym-1' } as never);
    });
    expect(client.getQueryState(gymBoardsQueryKey('gym-1'))?.isInvalidated).toBe(false);
  });
});
