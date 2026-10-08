// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { GET_USER_CLIMB_PERCENTILE, GET_USER_PROFILE_STATS, GET_USER_TICKS } from '@boardsesh/graphql/operations';
import { useProfileData } from '../use-profile-data';

vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'viewer-token' }) }));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: vi.fn(),
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: vi.fn(),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const mockUseSession = vi.mocked(useSession);
const mockUseSnackbar = vi.mocked(useSnackbar);
const mockUseGradeFormat = vi.mocked(useGradeFormat);

function renderProfileDataHook<T>(callback: () => T, options?: { isRestoring?: boolean }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
  const isRestoring = options?.isRestoring ?? false;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <IsRestoringProvider value={isRestoring}>{children}</IsRestoringProvider>
    </QueryClientProvider>
  );
  const rendered = renderHook(callback, { wrapper });
  return { ...rendered, queryClient };
}

describe('useProfileData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'user-1' }, expires: '' },
      update: vi.fn(),
    });
    mockUseSnackbar.mockReturnValue({ showMessage: vi.fn() });
    mockUseGradeFormat.mockReturnValue({
      gradeFormat: 'v-grade',
      loaded: true,
      setGradeFormat: vi.fn(async () => {}),
      formatGrade: vi.fn((difficulty: string | null | undefined) => difficulty ?? null),
      getGradeColor: vi.fn(() => undefined),
    });
    mockRequest.mockResolvedValue({ userClimbPercentile: null });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response),
    );
  });

  it('adds explicit send and flash status metadata to hardest grade highlights', () => {
    const { result } = renderProfileDataHook(() =>
      useProfileData('user-1', {
        initialProfile: {
          id: 'user-1',
          email: undefined,
          name: 'Test User',
          image: null,
          profile: null,
          credentials: [],
          followerCount: 0,
          followingCount: 0,
          isFollowedByMe: false,
        },
        initialProfileStats: {
          totalDistinctClimbs: 3,
          layoutStats: [],
        },
        initialPercentile: {
          totalDistinctClimbs: 3,
          percentile: 75,
          totalActiveUsers: 20,
        },
        initialAllBoardsTicks: {
          kilter: [
            {
              climbed_at: '2025-01-01T12:00:00Z',
              difficulty: 22,
              tries: 3,
              angle: 40,
              status: 'send',
              layoutId: 1,
              boardType: 'kilter',
              climbUuid: 'send-climb',
            },
            {
              climbed_at: '2025-01-02T12:00:00Z',
              difficulty: 20,
              tries: 1,
              angle: 40,
              status: 'flash',
              layoutId: 1,
              boardType: 'kilter',
              climbUuid: 'flash-climb',
            },
            {
              climbed_at: '2025-01-03T12:00:00Z',
              difficulty: 24,
              tries: 2,
              angle: 40,
              status: 'attempt',
              layoutId: 1,
              boardType: 'kilter',
              climbUuid: 'attempt-climb',
            },
          ],
        },
        initialLogbook: [],
        initialIsOwnProfile: true,
      }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.hardestSend).toMatchObject({ label: 'V6', status: 'send' });
    expect(result.current.hardestFlash).toMatchObject({ label: 'V5', status: 'flash' });
    expect(result.current.percentile).toMatchObject({ percentile: 75, totalActiveUsers: 20 });
  });

  it('fetches missing profile, ticks, stats, and percentile data on mount', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Fetched User',
        image: null,
        profile: null,
        credentials: [],
        followerCount: 4,
        followingCount: 2,
        isFollowedByMe: false,
      }),
    } as Response);

    mockRequest.mockImplementation(async (request: { document: unknown; variables?: Record<string, unknown> }) => {
      const { document: query, variables } = request;
      if (query === GET_USER_TICKS && variables?.boardType === 'kilter') {
        return {
          userTicks: [
            {
              climbedAt: '2025-01-01T12:00:00Z',
              difficulty: 22,
              attemptCount: 2,
              angle: 40,
              status: 'send',
              layoutId: 1,
              climbUuid: 'fetched-send',
            },
          ],
        };
      }
      if (query === GET_USER_TICKS) {
        return { userTicks: [] };
      }
      if (query === GET_USER_PROFILE_STATS) {
        return {
          userProfileStats: {
            totalDistinctClimbs: 1,
            layoutStats: [],
          },
        };
      }
      if (query === GET_USER_CLIMB_PERCENTILE) {
        return {
          userClimbPercentile: {
            totalDistinctClimbs: 1,
            percentile: 90,
            totalActiveUsers: 10,
          },
        };
      }
      return {};
    });

    const { result } = renderProfileDataHook(() => useProfileData('user-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.loadingAggregated).toBe(false);
      expect(result.current.loadingProfileStats).toBe(false);
    });

    expect(fetch).toHaveBeenCalledWith('/api/internal/profile/user-1', { signal: expect.any(AbortSignal) });
    expect(result.current.profile?.name).toBe('Fetched User');
    expect(result.current.statisticsSummary.totalAscents).toBe(1);
    expect(result.current.hardestSend).toMatchObject({ label: 'V6', status: 'send' });
    expect(result.current.percentile).toMatchObject({ percentile: 90, totalActiveUsers: 10 });
  });

  it('recomputes hardest grades when filtering to a single board', async () => {
    const { result } = renderProfileDataHook(() =>
      useProfileData('user-1', {
        initialProfile: {
          id: 'user-1',
          email: undefined,
          name: 'Test User',
          image: null,
          profile: null,
          credentials: [],
          followerCount: 0,
          followingCount: 0,
          isFollowedByMe: false,
        },
        initialProfileStats: {
          totalDistinctClimbs: 4,
          layoutStats: [],
        },
        initialPercentile: {
          totalDistinctClimbs: 4,
          percentile: 80,
          totalActiveUsers: 20,
        },
        initialAllBoardsTicks: {
          kilter: [
            {
              climbed_at: '2025-01-01T12:00:00Z',
              difficulty: 22,
              tries: 3,
              angle: 40,
              status: 'send',
              layoutId: 1,
              boardType: 'kilter',
              climbUuid: 'kilter-send',
            },
          ],
          tension: [
            {
              climbed_at: '2025-01-02T12:00:00Z',
              difficulty: 24,
              tries: 1,
              angle: 40,
              status: 'flash',
              layoutId: 9,
              boardType: 'tension',
              climbUuid: 'tension-flash',
            },
          ],
        },
        initialLogbook: [],
        initialIsOwnProfile: true,
      }),
    );

    expect(result.current.hardestSend).toMatchObject({ label: 'V8', status: 'send' });
    expect(result.current.hardestFlash).toMatchObject({ label: 'V8', status: 'flash' });

    act(() => {
      result.current.setSelectedBoard('kilter');
    });

    expect(result.current.hardestSend).toMatchObject({ label: 'V6', status: 'send' });
    expect(result.current.hardestFlash).toBeNull();
  });

  it('treats SSR-seeded initial data as fresh and does not refetch on mount', async () => {
    renderProfileDataHook(() =>
      useProfileData('user-1', {
        initialProfile: {
          id: 'user-1',
          email: undefined,
          name: 'SSR User',
          image: null,
          profile: null,
          credentials: [],
          followerCount: 0,
          followingCount: 0,
          isFollowedByMe: false,
        },
        initialProfileStats: { totalDistinctClimbs: 0, layoutStats: [] },
        initialPercentile: { totalDistinctClimbs: 0, percentile: 0, totalActiveUsers: 0 },
        initialAllBoardsTicks: { kilter: [] },
        initialLogbook: [],
        initialIsOwnProfile: true,
      }),
    );

    // Flush pending microtasks (React-Query effect bookkeeping) without
    // sleeping — using a real timer would race against test scheduling.
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalledWith(GET_USER_PROFILE_STATS, { userId: 'user-1' });
    expect(mockRequest).not.toHaveBeenCalledWith(GET_USER_CLIMB_PERCENTILE, { userId: 'user-1' });
    expect(mockRequest).not.toHaveBeenCalledWith(GET_USER_TICKS, { userId: 'user-1', boardType: 'kilter' });
  });

  it('flags notFound when the profile endpoint returns 404', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

    const { result } = renderProfileDataHook(() => useProfileData('missing-user'));

    await waitFor(() => {
      expect(result.current.notFound).toBe(true);
    });
    expect(result.current.profile).toBeNull();
  });

  it('seeds percentile from initial data without waiting on a fetch', () => {
    const initialPercentile = {
      totalDistinctClimbs: 12,
      percentile: 90,
      totalActiveUsers: 40,
    };

    const { result } = renderProfileDataHook(() =>
      useProfileData('user-1', {
        initialProfile: {
          id: 'user-1',
          email: undefined,
          name: 'Test User',
          image: null,
          profile: null,
          credentials: [],
          followerCount: 0,
          followingCount: 0,
          isFollowedByMe: false,
        },
        initialProfileStats: {
          totalDistinctClimbs: 12,
          layoutStats: [],
        },
        initialPercentile,
        initialAllBoardsTicks: {
          kilter: [],
        },
        initialLogbook: [],
        initialIsOwnProfile: true,
      }),
    );

    expect(result.current.percentile).toEqual(initialPercentile);
  });

  it('does not show loading skeleton when SSR data is present but persister is still restoring', () => {
    const { result } = renderProfileDataHook(
      () =>
        useProfileData('user-1', {
          initialProfile: {
            id: 'user-1',
            email: undefined,
            name: 'SSR User',
            image: null,
            profile: null,
            credentials: [],
            followerCount: 0,
            followingCount: 0,
            isFollowedByMe: false,
          },
          initialProfileStats: { totalDistinctClimbs: 0, layoutStats: [] },
          initialPercentile: null,
          initialAllBoardsTicks: { kilter: [] },
          initialLogbook: [],
          initialIsOwnProfile: true,
        }),
      { isRestoring: true },
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.loadingAggregated).toBe(false);
    expect(result.current.loadingProfileStats).toBe(false);
  });

  it('only flags queries for IDB persistence when viewing your own profile', () => {
    const ssrSeed = {
      initialProfile: {
        id: 'user-1',
        email: undefined,
        name: 'Test',
        image: null,
        profile: null,
        credentials: [],
        followerCount: 0,
        followingCount: 0,
        isFollowedByMe: false,
      },
      initialProfileStats: { totalDistinctClimbs: 0, layoutStats: [] },
      initialPercentile: null,
      initialAllBoardsTicks: { kilter: [] },
      initialLogbook: [],
    };

    const ownView = renderProfileDataHook(() => useProfileData('user-1', { ...ssrSeed, initialIsOwnProfile: true }));
    const persistedOwnKeys = ownView.queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.meta?.persist === true)
      .map((query) => query.queryKey);
    expect(persistedOwnKeys).toEqual(
      expect.arrayContaining([
        ['userProfile', 'user-1'],
        ['userTicks', 'user-1'],
        ['userProfileStats', 'user-1'],
        ['userClimbPercentile', 'user-1'],
      ]),
    );

    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: 'viewer-id' }, expires: '' },
      update: vi.fn(),
    });
    const otherView = renderProfileDataHook(() =>
      useProfileData('other-user', { ...ssrSeed, initialIsOwnProfile: false }),
    );
    const persistedOtherKeys = otherView.queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.meta?.persist === true);
    expect(persistedOtherKeys).toEqual([]);
  });

  it('logs ticks/stats/percentile query failures to the console', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRequest.mockImplementation(async (request: { document: unknown }) => {
      const query = request.document;
      if (query === GET_USER_TICKS) throw new Error('ticks boom');
      if (query === GET_USER_PROFILE_STATS) throw new Error('stats boom');
      if (query === GET_USER_CLIMB_PERCENTILE) throw new Error('percentile boom');
      return {};
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'user-1',
        email: undefined,
        name: 'Test',
        image: null,
        profile: null,
        credentials: [],
        followerCount: 0,
        followingCount: 0,
        isFollowedByMe: false,
      }),
    } as Response);

    renderProfileDataHook(() => useProfileData('user-1'));

    await waitFor(() => {
      const messages = consoleErrorSpy.mock.calls.map((args) => String(args[0]));
      expect(messages.some((m) => m.includes('all boards ticks'))).toBe(true);
      expect(messages.some((m) => m.includes('profile stats'))).toBe(true);
      expect(messages.some((m) => m.includes('climb percentile'))).toBe(true);
    });

    consoleErrorSpy.mockRestore();
  });
});
