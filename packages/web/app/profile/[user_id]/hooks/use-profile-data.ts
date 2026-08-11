'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_TICKS,
  type GetUserTicksQueryVariables,
  type GetUserTicksQueryResponse,
  GET_USER_PROFILE_STATS,
  type GetUserProfileStatsQueryVariables,
  type GetUserProfileStatsQueryResponse,
  GET_USER_CLIMB_PERCENTILE,
  type GetUserClimbPercentileQueryResponse,
  GET_PUBLIC_PROFILE,
} from '@boardsesh/graphql/operations';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import {
  type UserProfile,
  type LogbookEntry,
  type UnifiedTimeframeType,
  BOARD_TYPES,
  getDifficultyMapping,
} from '../utils/profile-constants';
import { getGradeColor, getGradeTextColor } from '@/app/lib/grade-colors';
import { isAbortError } from '@/app/lib/is-abort-error';
import { PERSIST_MAX_AGE_MS } from '@/app/lib/react-query-idb-persister';
import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildAggregatedFlashRedpointBars,
  buildStatisticsSummary,
  buildVPointsTimeline,
} from '../utils/chart-data-builders';

type InitialData = {
  initialProfile?: UserProfile;
  initialProfileStats?: GetUserProfileStatsQueryResponse['userProfileStats'];
  initialPercentile?: GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null;
  initialAllBoardsTicks?: Record<string, LogbookEntry[]>;
  initialLogbook?: LogbookEntry[];
  initialIsOwnProfile?: boolean;
  initialNotFound?: boolean;
};

type BoardTicks = Record<string, LogbookEntry[]>;

type GetPublicProfileResponse = {
  publicProfile: PublicUserProfile | null;
};

// A null `publicProfile` is meaningful: the user wants the "not found" page.
// Tag it so the query consumer can branch on it without parsing strings.
class ProfileNotFoundError extends Error {
  readonly code = 'PROFILE_NOT_FOUND';
  constructor() {
    super('Profile not found');
  }
}

// Brief freshness window so consumers with SSR-seeded `initialData` (tagged
// with `initialDataUpdatedAt: Date.now()`) don't fire a redundant network
// request the moment they mount — `refetchOnMount` defaults to `true` for
// those queries, which means "refetch only if stale". The /you path has no
// initial data and uses `refetchOnMount: 'always'`, so the staleTime is
// irrelevant there: every visit triggers a background refetch.
const PROFILE_STALE_TIME_MS = 30 * 1000;

// Persisted IDB cache lifetime — aligned with the persister so a query never
// outlives its dehydrated copy.
const PROFILE_GC_TIME_MS = PERSIST_MAX_AGE_MS;

export function useProfileData(userId: string, initialData?: InitialData) {
  const { data: session } = useSession();
  const { token: authToken, isLoading: authTokenLoading } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const { gradeFormat } = useGradeFormat();
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();

  const [selectedBoard, setSelectedBoard] = useState<string>('all');
  const [unifiedTimeframe, setUnifiedTimeframe] = useState<UnifiedTimeframeType>('all');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  // Drives both the UI's "own profile" branches and whether we persist the
  // four queries to IDB. Persisting other users' profile data would let it
  // accumulate unbounded across one-off visits (capped only by 24h maxAge).
  //
  // First-render correctness depends on the `initialIsOwnProfile` seed:
  // /you passes `true`; /profile/[user_id] passes `viewerUserId === user_id`
  // from server-side auth. Without that seed, the value flips false → true
  // when NextAuth resolves on the next render, and queries created during
  // the loading window get `meta.persist = false`. React Query reads `meta`
  // from the latest options on every render, so the dehydrate predicate
  // picks up the flipped flag on the next persist tick — but make sure any
  // new caller passes `initialIsOwnProfile` to avoid a brief window where
  // the cache wouldn't be persisted.
  const isOwnProfile = session?.user?.id ? session.user.id === userId : (initialData?.initialIsOwnProfile ?? false);

  const profileInitial = initialData?.initialProfile;
  const profileQuery = useQuery<UserProfile>({
    queryKey: ['userProfile', userId],
    queryFn: async () => {
      // Authenticated on purpose: `isFollowedByMe` is resolved from the bearer
      // token. Firing this anonymously would come back false and stomp the
      // SSR-seeded "Following" state on every refetch.
      const client = createGraphQLHttpClient(authToken);
      const response = await client.request<GetPublicProfileResponse>(GET_PUBLIC_PROFILE, { userId });
      const publicProfile = response.publicProfile;
      if (!publicProfile) throw new ProfileNotFoundError();
      return {
        id: publicProfile.id,
        // publicProfile never exposes an email. On your own profile it comes
        // from the NextAuth session instead — the only place it's rendered.
        email: session?.user?.id === userId ? (session?.user?.email ?? undefined) : undefined,
        displayName: publicProfile.displayName ?? null,
        avatarUrl: publicProfile.avatarUrl ?? null,
        instagramUrl: publicProfile.instagramUrl ?? null,
        followerCount: publicProfile.followerCount ?? 0,
        followingCount: publicProfile.followingCount ?? 0,
        isFollowedByMe: publicProfile.isFollowedByMe ?? false,
      } satisfies UserProfile;
    },
    // Wait for ws-auth to settle. Racing it would send the request with no
    // bearer token and resolve isFollowedByMe as false for a signed-in viewer.
    enabled: !initialData?.initialNotFound && !authTokenLoading,
    staleTime: PROFILE_STALE_TIME_MS,
    gcTime: PROFILE_GC_TIME_MS,
    refetchOnMount: profileInitial ? true : 'always',
    retry: (failureCount, error) => !(error instanceof ProfileNotFoundError) && failureCount < 3,
    initialData: profileInitial,
    initialDataUpdatedAt: profileInitial ? Date.now() : undefined,
    meta: { persist: isOwnProfile },
  });

  const profileError = profileQuery.error;
  const notFound = (initialData?.initialNotFound ?? false) || profileError instanceof ProfileNotFoundError;

  useEffect(() => {
    if (!profileError) return;
    if (profileError instanceof ProfileNotFoundError) return;
    if (isAbortError(profileError)) return;
    console.error('Failed to fetch profile:', profileError);
    showMessage('Failed to load profile data', 'error');
  }, [profileError, showMessage]);

  // The other three queries don't surface a snackbar (the page still renders
  // partial data), but their failures shouldn't be silent in logs/Sentry.

  const ticksInitial = initialData?.initialAllBoardsTicks;
  const ticksQuery = useQuery<BoardTicks>({
    queryKey: ['userTicks', userId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(null);
      const collected: BoardTicks = {};
      await Promise.all(
        BOARD_TYPES.map(async (boardType) => {
          const variables: GetUserTicksQueryVariables = { userId, boardType };
          const response = await client.request<GetUserTicksQueryResponse>(GET_USER_TICKS, variables);
          collected[boardType] = response.userTicks.map((tick) => ({
            climbed_at: tick.climbedAt,
            difficulty: tick.difficulty,
            effectiveDifficulty: tick.effectiveDifficulty ?? null,
            tries: tick.attemptCount,
            angle: tick.angle,
            status: tick.status,
            layoutId: tick.layoutId,
            boardType,
            climbUuid: tick.climbUuid,
          }));
        }),
      );
      return collected;
    },
    staleTime: PROFILE_STALE_TIME_MS,
    gcTime: PROFILE_GC_TIME_MS,
    refetchOnMount: ticksInitial ? true : 'always',
    initialData: ticksInitial,
    initialDataUpdatedAt: ticksInitial ? Date.now() : undefined,
    meta: { persist: isOwnProfile },
  });

  const profileStatsInitial = initialData?.initialProfileStats;
  const profileStatsQuery = useQuery<GetUserProfileStatsQueryResponse['userProfileStats']>({
    queryKey: ['userProfileStats', userId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(null);
      const variables: GetUserProfileStatsQueryVariables = { userId };
      const response = await client.request<GetUserProfileStatsQueryResponse>(GET_USER_PROFILE_STATS, variables);
      return response.userProfileStats;
    },
    staleTime: PROFILE_STALE_TIME_MS,
    gcTime: PROFILE_GC_TIME_MS,
    refetchOnMount: profileStatsInitial ? true : 'always',
    initialData: profileStatsInitial,
    initialDataUpdatedAt: profileStatsInitial ? Date.now() : undefined,
    meta: { persist: isOwnProfile },
  });

  // initialPercentile is `undefined` when no SSR seed was passed, and `null`
  // when SSR explicitly returned no percentile (e.g. user with zero climbs).
  // Treat both presences of a key as "have initial data" so a legitimate null
  // doesn't trigger an unnecessary refetch.
  const hasPercentileInitial = initialData ? 'initialPercentile' in initialData : false;
  const percentileInitial = initialData?.initialPercentile;
  const percentileQuery = useQuery<GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null>({
    queryKey: ['userClimbPercentile', userId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(null);
      const response = await client.request<GetUserClimbPercentileQueryResponse>(GET_USER_CLIMB_PERCENTILE, {
        userId,
      });
      return response.userClimbPercentile;
    },
    staleTime: PROFILE_STALE_TIME_MS,
    gcTime: PROFILE_GC_TIME_MS,
    refetchOnMount: hasPercentileInitial ? true : 'always',
    initialData: percentileInitial,
    initialDataUpdatedAt: hasPercentileInitial ? Date.now() : undefined,
    meta: { persist: isOwnProfile },
  });

  useEffect(() => {
    const err = ticksQuery.error;
    if (!err || isAbortError(err)) return;
    console.error('Error fetching all boards ticks:', err);
  }, [ticksQuery.error]);

  useEffect(() => {
    const err = profileStatsQuery.error;
    if (!err || isAbortError(err)) return;
    console.error('Error fetching profile stats:', err);
  }, [profileStatsQuery.error]);

  useEffect(() => {
    const err = percentileQuery.error;
    if (!err || isAbortError(err)) return;
    console.error('Error fetching climb percentile:', err);
  }, [percentileQuery.error]);

  const profile = profileQuery.data ?? null;
  const profileStats = profileStatsQuery.data ?? null;
  const percentile = percentileQuery.data ?? null;
  const allBoardsTicks = useMemo<BoardTicks>(() => ticksQuery.data ?? {}, [ticksQuery.data]);

  const setProfile = useCallback(
    (next: UserProfile) => {
      queryClient.setQueryData<UserProfile>(['userProfile', userId], next);
    },
    [queryClient, userId],
  );

  // `loading` is the first-paint gate. Only show it when there's genuinely no
  // data to render — if SSR seeded `initialData` we want to render immediately
  // even while the persister is still hydrating from IDB in the background.
  const loading = !notFound && !profile && (isRestoring || profileQuery.isPending);
  const loadingAggregated = !notFound && !ticksQuery.data && (isRestoring || ticksQuery.isPending);
  const loadingProfileStats = !notFound && !profileStats && (isRestoring || profileStatsQuery.isPending);

  // Filter allBoardsTicks by selected board
  const filteredBoardsTicks = useMemo<BoardTicks>(() => {
    if (selectedBoard === 'all') return allBoardsTicks;
    return { [selectedBoard]: allBoardsTicks[selectedBoard] || [] };
  }, [allBoardsTicks, selectedBoard]);

  // Flat logbook from filtered boards, with timeframe applied
  const filteredLogbook = useMemo(() => {
    const flat = Object.values(filteredBoardsTicks).flat();
    return filterLogbookByTimeframe(flat, unifiedTimeframe, fromDate, toDate);
  }, [filteredBoardsTicks, unifiedTimeframe, fromDate, toDate]);

  const aggregatedStackedBars = useMemo(
    () => buildAggregatedStackedBars(filteredBoardsTicks, unifiedTimeframe, gradeFormat, fromDate, toDate),
    [filteredBoardsTicks, unifiedTimeframe, gradeFormat, fromDate, toDate],
  );

  const weeklyBars = useMemo(
    () => buildWeeklyBars(filteredLogbook, undefined, undefined, gradeFormat),
    [filteredLogbook, gradeFormat],
  );

  const aggregatedFlashRedpointBars = useMemo(
    () => buildAggregatedFlashRedpointBars(filteredBoardsTicks, unifiedTimeframe, gradeFormat, fromDate, toDate),
    [filteredBoardsTicks, unifiedTimeframe, gradeFormat, fromDate, toDate],
  );

  const statisticsSummary = useMemo(
    () => buildStatisticsSummary(profileStats, gradeFormat),
    [profileStats, gradeFormat],
  );

  const vPointsTimeline = useMemo(
    () => buildVPointsTimeline(filteredBoardsTicks, unifiedTimeframe, fromDate, toDate),
    [filteredBoardsTicks, unifiedTimeframe, fromDate, toDate],
  );

  // Compute hardest send and hardest flash from filtered ticks
  const { hardestSend, hardestFlash } = useMemo(() => {
    const allTicks = Object.values(filteredBoardsTicks).flat();
    const mapping = getDifficultyMapping(gradeFormat);
    let maxSendDifficulty = -1;
    let maxFlashDifficulty = -1;

    for (const tick of allTicks) {
      // Prefer the server-coalesced consensus value; fall back to the raw
      // override when absent (test fixtures, transient optimistic writes).
      const grade = tick.effectiveDifficulty ?? tick.difficulty;
      if (grade == null) continue;
      if (tick.status === 'send' || tick.status === 'flash') {
        if (grade > maxSendDifficulty) maxSendDifficulty = grade;
      }
      if (tick.status === 'flash') {
        if (grade > maxFlashDifficulty) maxFlashDifficulty = grade;
      }
    }

    const makeHighlight = (difficulty: number, status: 'send' | 'flash') => {
      const label = mapping[difficulty] ?? `${difficulty}`;
      const color = getGradeColor(label) ?? 'var(--neutral-200)';
      const textColor = getGradeTextColor(color);
      return { label, color, textColor, status };
    };

    return {
      hardestSend: maxSendDifficulty >= 0 ? makeHighlight(maxSendDifficulty, 'send') : null,
      hardestFlash: maxFlashDifficulty >= 0 ? makeHighlight(maxFlashDifficulty, 'flash') : null,
    };
  }, [filteredBoardsTicks, gradeFormat]);

  return {
    // Profile state
    loading,
    notFound,
    profile,
    setProfile,
    isOwnProfile,

    // Board selection
    selectedBoard,
    setSelectedBoard,

    // Unified filters
    unifiedTimeframe,
    setUnifiedTimeframe,
    fromDate,
    setFromDate,
    toDate,
    setToDate,

    // Board stats
    allBoardsTicks,
    filteredLogbook,
    weeklyBars,

    // Aggregated stats
    loadingAggregated,
    aggregatedStackedBars,
    aggregatedFlashRedpointBars,

    // Profile stats summary
    loadingProfileStats,
    layoutStats: profileStats?.layoutStats ?? [],
    statisticsSummary,
    hardestSend,
    hardestFlash,

    // V-Points timeline
    vPointsTimeline,

    // Percentile ranking
    percentile,
  };
}
