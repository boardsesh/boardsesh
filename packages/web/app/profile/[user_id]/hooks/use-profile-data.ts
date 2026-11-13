'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
} from '@boardsesh/graphql/operations';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
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
import { browserBackendClient } from '@/app/lib/auth/browser-backend-client';
import { readSelectedBrowserProfile } from '@/app/lib/auth/browser-profile-client';
import { BrowserProfileAuthorityError, ProfileNotFoundError } from '@/app/lib/auth/browser-profile-response';
import { requestWebSessionRefresh } from '@/app/lib/auth/web-session-events';
import {
  browserBackendSessionKey,
  readBrowserBackendSessionScope,
} from '@boardsesh/auth-protocol/browser-backend-session';
import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildAggregatedFlashRedpointBars,
  buildStatisticsSummary,
  buildVPointsTimeline,
} from '../utils/chart-data-builders';

type InitialData = {
  /** This server response contains only independently public fallback data. */
  publicServerView?: boolean;
  initialProfile?: UserProfile;
  initialProfileStats?: GetUserProfileStatsQueryResponse['userProfileStats'];
  initialPercentile?: GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null;
  initialAllBoardsTicks?: Record<string, LogbookEntry[]>;
  initialLogbook?: LogbookEntry[];
  initialIsOwnProfile?: boolean;
  initialNotFound?: boolean;
};

type BoardTicks = Record<string, LogbookEntry[]>;

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
  const { token } = useWsAuthToken();
  const snapshot = useSyncExternalStore(
    browserBackendClient.subscribe,
    browserBackendClient.getSnapshot,
    browserBackendClient.getSnapshot,
  );
  const observation = readBrowserBackendSessionScope(session ?? null);
  const selectedRequired =
    initialData?.publicServerView === true ||
    snapshot.selected ||
    (session !== null && typeof session === 'object' && 'browserSelection' in session);
  const admissionCurrent = !selectedRequired || browserBackendClient.isSessionCurrent(session ?? null);
  const scopeKey = selectedRequired
    ? JSON.stringify([
        observation.status === 'selected' ? browserBackendSessionKey(observation.owner) : 'anonymous-or-unconfirmed',
        snapshot.revision,
      ])
    : null;
  const profileKey = useMemo(() => ['userProfile', userId, ...(scopeKey ? [scopeKey] : [])], [scopeKey, userId]);
  const ticksKey = useMemo(() => ['userTicks', userId, ...(scopeKey ? [scopeKey] : [])], [scopeKey, userId]);
  const statsKey = useMemo(() => ['userProfileStats', userId, ...(scopeKey ? [scopeKey] : [])], [scopeKey, userId]);
  const percentileKey = useMemo(
    () => ['userClimbPercentile', userId, ...(scopeKey ? [scopeKey] : [])],
    [scopeKey, userId],
  );
  const assertCurrent = useCallback(() => {
    if (
      selectedRequired &&
      (!browserBackendClient.isSessionCurrent(session ?? null) ||
        browserBackendClient.getSnapshot().revision !== snapshot.revision)
    )
      throw new BrowserProfileAuthorityError('superseded');
  }, [selectedRequired, session, snapshot.revision]);
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
  const isOwnProfile = selectedRequired
    ? admissionCurrent && observation.status === 'selected' && observation.owner.userId === userId
    : session?.user?.id
      ? session.user.id === userId
      : (initialData?.initialIsOwnProfile ?? false);

  const profileInitial = !selectedRequired || initialData?.publicServerView ? initialData?.initialProfile : undefined;
  const profileQuery = useQuery<UserProfile>({
    queryKey: profileKey,
    queryFn: async ({ signal }) => {
      if (selectedRequired) {
        assertCurrent();
        const profile = await readSelectedBrowserProfile({
          userId,
          session: session ?? null,
          client: browserBackendClient,
          fetch,
          signal,
          onDenied: requestWebSessionRefresh,
        });
        assertCurrent();
        return profile;
      }
      const response = await fetch(`/api/internal/profile/${userId}`, { signal });
      if (response.status === 404) throw new ProfileNotFoundError();
      if (!response.ok) throw new Error('Failed to fetch profile');
      const body = await response.json();
      return {
        id: body.id,
        email: body.email,
        name: body.name,
        image: body.image,
        profile: body.profile,
        credentials: body.credentials,
        followerCount: body.followerCount ?? 0,
        followingCount: body.followingCount ?? 0,
        isFollowedByMe: body.isFollowedByMe ?? false,
        isPrivate: body.isPrivate,
        canViewActivity: body.canViewActivity,
      } satisfies UserProfile;
    },
    enabled: !initialData?.initialNotFound && admissionCurrent,
    staleTime: PROFILE_STALE_TIME_MS,
    gcTime: PROFILE_GC_TIME_MS,
    refetchOnMount: selectedRequired ? 'always' : profileInitial ? true : 'always',
    retry: (failureCount, error) =>
      !(error instanceof ProfileNotFoundError) &&
      !(error instanceof BrowserProfileAuthorityError && error.code === 'superseded') &&
      failureCount < 3,
    initialData: profileInitial,
    initialDataUpdatedAt: profileInitial ? (selectedRequired ? 0 : Date.now()) : undefined,
    meta: { persist: isOwnProfile },
  });

  // RSC refreshes bring new authorization decisions without remounting this
  // client component. Only new props replace the cache; never reinstall the
  // original SSR snapshot after the revocation bridge has cleared it.
  const previousProfileSeed = useRef(profileInitial);
  useEffect(() => {
    if (selectedRequired) return;
    if (profileInitial !== previousProfileSeed.current) {
      previousProfileSeed.current = profileInitial;
      if (profileInitial) queryClient.setQueryData(profileKey, profileInitial);
    }
  }, [profileInitial, profileKey, queryClient, selectedRequired]);

  const profileError = profileQuery.error;
  const notFound = (initialData?.initialNotFound ?? false) || profileError instanceof ProfileNotFoundError;

  useEffect(() => {
    if (!profileError) return;
    if (profileError instanceof ProfileNotFoundError) return;
    if (profileError instanceof BrowserProfileAuthorityError && profileError.code === 'superseded') return;
    if (isAbortError(profileError)) return;
    console.error('Failed to fetch profile:', profileError);
    showMessage('Failed to load profile data', 'error');
  }, [profileError, showMessage]);

  // The other three queries don't surface a snackbar (the page still renders
  // partial data), but their failures shouldn't be silent in logs/Sentry.

  const ticksInitial = selectedRequired ? undefined : initialData?.initialAllBoardsTicks;
  const ticksQuery = useQuery<BoardTicks>({
    queryKey: ticksKey,
    enabled: admissionCurrent && (!session?.user?.id || !!token),
    queryFn: async ({ signal }) => {
      assertCurrent();
      const client = createGraphQLHttpClient(token);
      const collected: BoardTicks = {};
      await Promise.all(
        BOARD_TYPES.map(async (boardType) => {
          assertCurrent();
          const variables: GetUserTicksQueryVariables = { userId, boardType };
          const response = await client.request<GetUserTicksQueryResponse>({
            document: GET_USER_TICKS,
            variables,
            signal,
          });
          assertCurrent();
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
      assertCurrent();
      return collected;
    },
    staleTime: PROFILE_STALE_TIME_MS,
    gcTime: PROFILE_GC_TIME_MS,
    refetchOnMount: ticksInitial ? true : 'always',
    initialData: ticksInitial,
    initialDataUpdatedAt: ticksInitial ? Date.now() : undefined,
    meta: { persist: isOwnProfile },
  });

  const profileStatsInitial = selectedRequired ? undefined : initialData?.initialProfileStats;
  const profileStatsQuery = useQuery<GetUserProfileStatsQueryResponse['userProfileStats']>({
    queryKey: statsKey,
    enabled: admissionCurrent && (!session?.user?.id || !!token),
    queryFn: async ({ signal }) => {
      assertCurrent();
      const client = createGraphQLHttpClient(token);
      const variables: GetUserProfileStatsQueryVariables = { userId };
      const response = await client.request<GetUserProfileStatsQueryResponse>({
        document: GET_USER_PROFILE_STATS,
        variables,
        signal,
      });
      assertCurrent();
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
  const hasPercentileInitial = !selectedRequired && !!initialData && 'initialPercentile' in initialData;
  const percentileInitial = selectedRequired ? undefined : initialData?.initialPercentile;
  const percentileQuery = useQuery<GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null>({
    queryKey: percentileKey,
    enabled: admissionCurrent && (!session?.user?.id || !!token),
    queryFn: async ({ signal }) => {
      assertCurrent();
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetUserClimbPercentileQueryResponse>({
        document: GET_USER_CLIMB_PERCENTILE,
        variables: { userId },
        signal,
      });
      assertCurrent();
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
    if (err instanceof BrowserProfileAuthorityError && err.code === 'superseded') return;
    console.error('Error fetching all boards ticks:', err);
  }, [ticksQuery.error]);

  useEffect(() => {
    const err = profileStatsQuery.error;
    if (!err || isAbortError(err)) return;
    if (err instanceof BrowserProfileAuthorityError && err.code === 'superseded') return;
    console.error('Error fetching profile stats:', err);
  }, [profileStatsQuery.error]);

  useEffect(() => {
    const err = percentileQuery.error;
    if (!err || isAbortError(err)) return;
    if (err instanceof BrowserProfileAuthorityError && err.code === 'superseded') return;
    console.error('Error fetching climb percentile:', err);
  }, [percentileQuery.error]);

  const profile = admissionCurrent ? (profileQuery.data ?? null) : (profileInitial ?? null);
  const profileStats = admissionCurrent ? (profileStatsQuery.data ?? null) : null;
  const percentile = admissionCurrent ? (percentileQuery.data ?? null) : null;
  const allBoardsTicks = useMemo<BoardTicks>(
    () => (admissionCurrent ? (ticksQuery.data ?? {}) : {}),
    [admissionCurrent, ticksQuery.data],
  );

  const setProfile = useCallback(
    (next: UserProfile) => {
      assertCurrent();
      queryClient.setQueryData<UserProfile>(profileKey, next);
    },
    [assertCurrent, profileKey, queryClient],
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
    let maxSendDifficulty = -1;
    let maxFlashDifficulty = -1;
    let hardestSendBoard: string | null = null;
    let hardestFlashBoard: string | null = null;

    for (const [boardType, ticks] of Object.entries(filteredBoardsTicks)) {
      for (const tick of ticks) {
        // Prefer the server-coalesced consensus value; fall back to the raw
        // override when absent (test fixtures, transient optimistic writes).
        const grade = tick.effectiveDifficulty ?? tick.difficulty;
        if (grade == null) continue;
        if ((tick.status === 'send' || tick.status === 'flash') && grade > maxSendDifficulty) {
          maxSendDifficulty = grade;
          hardestSendBoard = boardType;
        }
        if (tick.status === 'flash' && grade > maxFlashDifficulty) {
          maxFlashDifficulty = grade;
          hardestFlashBoard = boardType;
        }
      }
    }

    // Labelled on the hardest tick's board: MoonBoard's 6A reads V2.
    const makeHighlight = (difficulty: number, status: 'send' | 'flash', boardType: string | null) => {
      const label = getDifficultyMapping(gradeFormat, boardType)[difficulty] ?? `${difficulty}`;
      const color = getGradeColor(label) ?? 'var(--neutral-200)';
      const textColor = getGradeTextColor(color);
      return { label, color, textColor, status };
    };

    return {
      hardestSend: maxSendDifficulty >= 0 ? makeHighlight(maxSendDifficulty, 'send', hardestSendBoard) : null,
      hardestFlash: maxFlashDifficulty >= 0 ? makeHighlight(maxFlashDifficulty, 'flash', hardestFlashBoard) : null,
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
