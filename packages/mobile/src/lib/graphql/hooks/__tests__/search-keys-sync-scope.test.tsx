// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { offlineBoardKeyForBoard, parseOfflineBoardKey, scopedInvalidateFilters } from '@boardsesh/offline-sync';

// Issue #6302. A sync pull refreshes the climb-search keys through
// `scopedInvalidateFilters`, which reaches a query only when its key carries the
// board whose rows moved. That reads the key's shape: `[head, ClimbSearchInput,
// viewerId?]`. A hook that reshaped its key (the input nested, the board renamed)
// would keep matching by the predicate's "cannot read it, refresh it" fallback,
// so the cost comes back without anything failing. This pins the shape from the
// real hooks: a pull for another board must leave the query alone.

const requestMock = vi.fn();
vi.mock('../../offline-request', () => ({
  offlineAwareRequest: (query: unknown, variables: unknown) => requestMock(query, variables),
}));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: () => undefined,
  useBoardseshGradeEnabled: () => false,
}));
vi.mock('../../../boardsesh-grades-preference', () => ({
  useBoardseshGradesPreference: () => ({ enabled: false, loaded: true }),
}));
vi.mock('../../../../hooks/use-current-user-id', () => ({ useStoredUserId: () => ({ userId: 'viewer-1' }) }));
vi.mock('@boardsesh/board-react', () => ({ useBoardAdapter: () => ({ isAuthenticated: true }) }));

// The hooks barrel re-exports siblings that pull in react-native / expo-router.
// The two search hooks touch none of them.
vi.mock('react-native', () => ({}));
vi.mock('../use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
vi.mock('../use-similar-climbs', () => ({ useSimilarClimbs: vi.fn() }));
vi.mock('../use-beta-link-preview', () => ({ useBetaLinkPreview: vi.fn() }));
vi.mock('../use-delete-account', () => ({ useDeleteAccountInfo: vi.fn(), useDeleteAccount: vi.fn() }));
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
vi.mock('../use-integrations', () => ({
  useIntegrationStatuses: vi.fn(),
  useDisconnectIntegration: vi.fn(),
  useSetIntegrationAutoSync: vi.fn(),
  useSyncSessionToIntegration: vi.fn(),
}));

import { useSearchClimbs, useSearchClimbsCount } from '../index';

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10 };
const searchInput: ClimbSearchInput = {
  boardName: board.boardType,
  layoutId: board.layoutId,
  sizeId: board.sizeId,
  setIds: '1,20',
  angle: 40,
  page: 0,
  pageSize: 30,
};

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ searchClimbs: { climbs: [], hasMore: false, totalCount: 0 } });
});

describe('sync invalidation scope of the search hooks', () => {
  it.each([
    ['useSearchClimbs', 'searchClimbs', useSearchClimbs],
    ['useSearchClimbsCount', 'searchClimbsCount', useSearchClimbsCount],
  ] as const)('%s refetches for its own board and no other', async (_hookName, head, useSearchHook) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    // The everyday list, and a Following search: its key gains the viewer id.
    const everyday = renderHook(() => useSearchHook(searchInput), { wrapper });
    const following = renderHook(() => useSearchHook({ ...searchInput, onlyFollowedAuthors: true }), { wrapper });
    try {
      await waitFor(() => {
        expect(everyday.result.current.isSuccess).toBe(true);
        expect(following.result.current.isSuccess).toBe(true);
      });
      expect(requestMock).toHaveBeenCalledTimes(2);

      // Rows landed for a spray wall, and for another layout of the same board.
      await act(async () => {
        await queryClient.invalidateQueries(scopedInvalidateFilters([head], { boardType: 'spray', layoutId: 36 }));
        await queryClient.invalidateQueries(scopedInvalidateFilters([head], { boardType: 'kilter', layoutId: 8 }));
      });
      expect(requestMock).toHaveBeenCalledTimes(2);

      // Rows landed for this board, addressed the way a download is stored.
      const ownScope = parseOfflineBoardKey(offlineBoardKeyForBoard(board));
      expect(ownScope).not.toBeNull();
      await act(async () => {
        await queryClient.invalidateQueries(scopedInvalidateFilters([head], ownScope));
      });
      expect(requestMock).toHaveBeenCalledTimes(4);
    } finally {
      everyday.unmount();
      following.unmount();
    }
  });
});
