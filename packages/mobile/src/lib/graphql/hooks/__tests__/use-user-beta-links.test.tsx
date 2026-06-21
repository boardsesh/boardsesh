// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { GET_USER_BETA_LINKS, type RecentBetaLinkGqlRow } from '@boardsesh/graphql/operations/beta-links';

// useUserBetaLinks is a manual offset-paged store (not React Query): it dedupes
// + video-filters across pages, advances the DB offset by the requested page
// size, and uses a generation counter so a request still in flight when the
// user changes can't write stale data. The dedupe/filter helpers (mapBetaLink,
// isBetaVideoUrl, betaLinkIdentity) run for real against real beta URLs.

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// The hooks barrel transitively pulls in react-native / expo-router via sibling
// hooks. useUserBetaLinks touches none of them, so stub the heavy re-exports so
// the barrel parses under the node/jsdom transform (mirrors use-recent-beta-links).
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

import { useUserBetaLinks } from '../index';

// Real beta video URLs that pass isBetaVideoUrl.
const IG_REEL_1 = 'https://www.instagram.com/reel/CAbCdEfGhIj/';
const IG_REEL_2 = 'https://www.instagram.com/reel/ZyXwVuTsRqP/';
const TIKTOK_VIDEO = 'https://www.tiktok.com/@some.user/video/7359000000000000000';
const NON_VIDEO_URL = 'https://youtube.com/watch?v=abc';

function makeRow(climbUuid: string, link: string): RecentBetaLinkGqlRow {
  return {
    climbName: 'Project',
    boardType: 'kilter',
    layoutId: 1,
    betaLink: {
      climbUuid,
      link,
      foreignUsername: null,
      angle: 40,
      thumbnail: '/static/beta-link-thumbnails/x.jpg',
      isListed: true,
      createdAt: '2026-01-01',
      tickUuid: null,
      boardId: null,
    },
  };
}

beforeEach(() => {
  requestMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useUserBetaLinks', () => {
  it('fetches page 0 for the user and exposes the video links', async () => {
    requestMock.mockResolvedValueOnce({ userBetaLinks: [makeRow('c1', IG_REEL_1), makeRow('c2', IG_REEL_2)] });

    const { result } = renderHook(() => useUserBetaLinks('user-1', 2));

    await waitFor(() => expect(result.current.videos).toHaveLength(2));
    expect(requestMock).toHaveBeenCalledWith(GET_USER_BETA_LINKS, { userId: 'user-1', limit: 2, offset: 0 });
    expect(result.current.videos.map((video) => video.betaLink.link)).toEqual([IG_REEL_1, IG_REEL_2]);
    // A full page back (2 rows === pageSize) means there may be more.
    expect(result.current.hasMore).toBe(true);
  });

  it('drops non-video links so the shelf only shows beta videos', async () => {
    requestMock.mockResolvedValueOnce({
      userBetaLinks: [makeRow('c1', IG_REEL_1), makeRow('c2', NON_VIDEO_URL), makeRow('c3', TIKTOK_VIDEO)],
    });

    const { result } = renderHook(() => useUserBetaLinks('user-1', 10));

    await waitFor(() => expect(result.current.videos).toHaveLength(2));
    expect(result.current.videos.map((video) => video.betaLink.link)).toEqual([IG_REEL_1, TIKTOK_VIDEO]);
    // A short page (< pageSize) means we reached the end.
    expect(result.current.hasMore).toBe(false);
  });

  it('loadMore requests the advanced offset and dedupes across pages', async () => {
    requestMock
      .mockResolvedValueOnce({ userBetaLinks: [makeRow('c1', IG_REEL_1), makeRow('c2', IG_REEL_2)] })
      // Page 1 repeats IG_REEL_2 (a boundary dup) and adds a new video.
      .mockResolvedValueOnce({ userBetaLinks: [makeRow('c2', IG_REEL_2), makeRow('c3', TIKTOK_VIDEO)] });

    const { result } = renderHook(() => useUserBetaLinks('user-1', 2));

    await waitFor(() => expect(result.current.videos).toHaveLength(2));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.videos).toHaveLength(3));
    expect(requestMock).toHaveBeenLastCalledWith(GET_USER_BETA_LINKS, { userId: 'user-1', limit: 2, offset: 2 });
    expect(result.current.videos.map((video) => video.betaLink.link)).toEqual([IG_REEL_1, IG_REEL_2, TIKTOK_VIDEO]);
  });

  it('surfaces an error, then refetch clears it and reloads', async () => {
    requestMock.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useUserBetaLinks('user-1', 2));

    await waitFor(() => expect(result.current.hasError).toBe(true));
    expect(result.current.videos).toHaveLength(0);

    requestMock.mockResolvedValueOnce({ userBetaLinks: [makeRow('c1', IG_REEL_1)] });
    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.videos).toHaveLength(1));
    expect(result.current.hasError).toBe(false);
  });

  it('discards a stale in-flight response when the user changes', async () => {
    let resolveA: (value: { userBetaLinks: RecentBetaLinkGqlRow[] }) => void = () => {};
    let resolveB: (value: { userBetaLinks: RecentBetaLinkGqlRow[] }) => void = () => {};
    const pageA = new Promise<{ userBetaLinks: RecentBetaLinkGqlRow[] }>((resolve) => {
      resolveA = resolve;
    });
    const pageB = new Promise<{ userBetaLinks: RecentBetaLinkGqlRow[] }>((resolve) => {
      resolveB = resolve;
    });
    requestMock.mockReturnValueOnce(pageA).mockReturnValueOnce(pageB);

    const { result, rerender } = renderHook(({ id }) => useUserBetaLinks(id, 2), {
      initialProps: { id: 'user-A' },
    });

    // Navigate to user-B while user-A's first page is still in flight.
    rerender({ id: 'user-B' });

    // user-A resolves late — its data must be discarded, not shown for user-B.
    await act(async () => {
      resolveA({ userBetaLinks: [makeRow('cA', IG_REEL_1)] });
      await Promise.resolve();
    });
    expect(result.current.videos).toHaveLength(0);

    // user-B resolves — only its data lands.
    await act(async () => {
      resolveB({ userBetaLinks: [makeRow('cB', TIKTOK_VIDEO)] });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.videos.map((video) => video.betaLink.link)).toEqual([TIKTOK_VIDEO]));
  });

  it('does not fetch without a userId', async () => {
    const { result } = renderHook(() => useUserBetaLinks(null, 2));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(requestMock).not.toHaveBeenCalled();
    expect(result.current.videos).toHaveLength(0);
  });
});
