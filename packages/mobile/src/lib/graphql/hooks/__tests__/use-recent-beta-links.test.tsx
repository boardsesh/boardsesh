// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GET_RECENT_BETA_LINKS, type RecentBetaLinkGqlRow } from '@boardsesh/graphql/operations/beta-links';

// The recent-beta shelf over-fetches when a layout is set (the server only
// narrows by board type) and then filters client-side to the selected layout,
// drops non-video links, and dedupes by stable video identity. The select body
// now lives in the exported `selectRecentBetaVideos` so we can pin that pure
// logic directly, plus one renderHook test for the queryFn's over-fetch
// multiplier (which lives in the request, not select).

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// The hooks barrel re-exports sibling hooks that transitively pull in
// react-native / expo-router (auth provider, you-data, social, session-detail).
// useRecentBetaLinks + selectRecentBetaVideos are pure React Query and touch
// none of them, so stub the heavy re-exports so the barrel parses under the
// node SSR transform.
vi.mock('react-native', () => ({}));
vi.mock('../use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
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
vi.mock('../use-integrations', () => ({
  useIntegrationStatuses: vi.fn(),
  useDisconnectIntegration: vi.fn(),
  useSetIntegrationAutoSync: vi.fn(),
  useSyncSessionToIntegration: vi.fn(),
}));

import { selectRecentBetaVideos, useRecentBetaLinks } from '../index';

// Real beta video URLs that pass isBetaVideoUrl (mirrors
// shared-schema/src/__tests__/beta-video-url.test.ts valid forms).
const IG_REEL_1 = 'https://www.instagram.com/reel/CAbCdEfGhIj/';
const IG_REEL_2 = 'https://www.instagram.com/reel/ZyXwVuTsRqP/';
const TIKTOK_VIDEO = 'https://www.tiktok.com/@some.user/video/7359000000000000000';
const NON_VIDEO_URL = 'https://youtube.com/watch?v=abc';

function makeRow(climbUuid: string, link: string, layoutId: number | null): RecentBetaLinkGqlRow {
  return {
    climbName: 'x',
    boardType: 'kilter',
    layoutId,
    betaLink: {
      climbUuid,
      link,
      foreignUsername: null,
      angle: 40,
      thumbnail: null,
      isListed: true,
      createdAt: '2026-01-01',
      tickUuid: null,
      boardId: null,
    },
  };
}

describe('selectRecentBetaVideos', () => {
  it('scopes to the selected layout and respects the limit', () => {
    const rows = [
      makeRow('c1', IG_REEL_1, 8),
      makeRow('c2', IG_REEL_2, 8),
      makeRow('c3', TIKTOK_VIDEO, 99),
      makeRow('c4', 'https://instagram.com/p/Xyz123/', 8),
      makeRow('c5', 'https://www.instagram.com/tv/AbCdE12/', 8),
    ];

    const result = selectRecentBetaVideos(rows, 8, 2);

    expect(result).toHaveLength(2);
    expect(result.every((video) => video.layoutId === 8)).toBe(true);
    // The layout-99 row must never appear regardless of the limit.
    expect(result.some((video) => video.betaLink.climb_uuid === 'c3')).toBe(false);
  });

  it('keeps all rows in original order when layoutId is null', () => {
    const rows = [
      makeRow('c1', IG_REEL_1, 8),
      makeRow('c2', IG_REEL_2, 99),
      makeRow('c3', TIKTOK_VIDEO, 8),
      makeRow('c4', 'https://instagram.com/p/Xyz123/', 7),
    ];

    const result = selectRecentBetaVideos(rows, null, 4);

    expect(result).toHaveLength(4);
    expect(result.map((video) => video.betaLink.link)).toEqual([
      IG_REEL_1,
      IG_REEL_2,
      TIKTOK_VIDEO,
      'https://instagram.com/p/Xyz123/',
    ]);
  });

  it('returns every valid row when the limit exceeds the row count', () => {
    const rows = [makeRow('c1', IG_REEL_1, 8), makeRow('c2', TIKTOK_VIDEO, 8)];

    expect(selectRecentBetaVideos(rows, 8, 10)).toHaveLength(2);
  });

  it('drops non-video links and dedupes repeated videos', () => {
    const rows = [
      makeRow('c1', IG_REEL_1, 8),
      makeRow('c2', NON_VIDEO_URL, 8),
      makeRow('c3', IG_REEL_1, 8),
      makeRow('c4', TIKTOK_VIDEO, 8),
    ];

    const result = selectRecentBetaVideos(rows, null, 10);

    expect(result).toHaveLength(2);
    expect(result.map((video) => video.betaLink.link)).toEqual([IG_REEL_1, TIKTOK_VIDEO]);
  });
});

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

describe('useRecentBetaLinks', () => {
  it('over-fetches 4x when a layout is set so the client filter can still fill the shelf', async () => {
    requestMock.mockResolvedValue({ recentBetaLinks: [] });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useRecentBetaLinks(20, 'kilter', 8), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledWith(GET_RECENT_BETA_LINKS, { limit: 80, boardType: 'kilter' });
  });

  it('requests exactly the limit when no layout filter is applied', async () => {
    requestMock.mockResolvedValue({ recentBetaLinks: [] });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useRecentBetaLinks(20, 'kilter', null), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestMock).toHaveBeenCalledWith(GET_RECENT_BETA_LINKS, { limit: 20, boardType: 'kilter' });
  });
});
