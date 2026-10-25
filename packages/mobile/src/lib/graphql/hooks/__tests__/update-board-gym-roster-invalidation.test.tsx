// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
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

import { useUpdateBoard, useUpdateSprayWall } from '../index';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(gymBoardsQueryKey('gym-1'), { gymBoards: [] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('board edits refresh the gym roster', () => {
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
});
