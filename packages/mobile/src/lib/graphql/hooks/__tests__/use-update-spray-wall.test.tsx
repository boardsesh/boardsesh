// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// #5488: Share on a wall climb reads the wall's slug and visibility off the
// registered wall, which is filled from the render payload. Saving the edit
// screen has to re-read that payload, or a public -> private flip keeps handing
// out the public link (and warming its card) for the registry's 10 minutes.

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

const invalidateRenderDataMock = vi.fn(async () => {});
vi.mock('../../../spray/spray-wall-loader', () => ({
  invalidateSprayWallRenderData: (...args: unknown[]) => invalidateRenderDataMock(...(args as [])),
}));

// The hooks barrel re-exports siblings that transitively pull in react-native /
// expo-router. usePinBoard is pure React Query and touches none of them, so stub
// the heavy re-exports so the barrel parses under the node SSR transform.
vi.mock('react-native', () => ({}));
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

import { useUpdateSprayWall } from '../index';

const WALL_UUID = '11111111-2222-3333-4444-555555555555';
const LAYOUT_ID = 4321;

describe('useUpdateSprayWall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-reads the wall's render payload so Share sees the new visibility", async () => {
    requestMock.mockResolvedValue({
      updateSprayWall: { uuid: WALL_UUID, layoutId: LAYOUT_ID, board: { isPublic: false, isUnlisted: false } },
    });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateSprayWall(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ uuid: WALL_UUID, isPublic: false } as unknown as Parameters<
        typeof result.current.mutateAsync
      >[0]);
    });

    expect(invalidateRenderDataMock).toHaveBeenCalledWith(queryClient, WALL_UUID, LAYOUT_ID);
  });
});
