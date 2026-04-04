'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_TICKS,
  type GetUserTicksQueryVariables,
  type GetUserTicksQueryResponse,
  GET_USER_PROFILE_STATS,
  type GetUserProfileStatsQueryVariables,
  type GetUserProfileStatsQueryResponse,
} from '@/app/lib/graphql/operations';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import {
  type UserProfile,
  type LogbookEntry,
  type TimeframeType,
  type AggregatedTimeframeType,
  BOARD_TYPES,
} from '../utils/profile-constants';
import {
  filterLogbookByTimeframe,
  buildAggregatedStackedBars,
  buildWeeklyBars,
  buildAggregatedFlashRedpointBars,
  buildStatisticsSummary,
} from '../utils/chart-data-builders';

export function useProfileData(userId: string) {
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [selectedBoard, setSelectedBoard] = useState<string>('kilter');
  const [logbook, setLogbook] = useState<LogbookEntry[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [timeframe, setTimeframe] = useState<TimeframeType>('all');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [aggregatedTimeframe, setAggregatedTimeframe] = useState<AggregatedTimeframeType>('all');
  const [allBoardsTicks, setAllBoardsTicks] = useState<Record<string, LogbookEntry[]>>({});
  const [loadingAggregated, setLoadingAggregated] = useState(false);
  const [profileStats, setProfileStats] = useState<GetUserProfileStatsQueryResponse['userProfileStats'] | null>(null);
  const [loadingProfileStats, setLoadingProfileStats] = useState(false);
  const [activeTab, setActiveTab] = useState<'activity' | 'createdClimbs'>('activity');
  const [weeklyFromDate, setWeeklyFromDate] = useState<string>('');
  const [weeklyToDate, setWeeklyToDate] = useState<string>('');

  const isOwnProfile = session?.user?.id === userId;
  const hasCredentials = (profile?.credentials?.length ?? 0) > 0;
  const authToken = (session as { authToken?: string } | null)?.authToken ?? null;

  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch(`/api/internal/profile/${userId}`);
      if (response.status === 404) {
        setNotFound(true);
        return;
      }
      if (!response.ok) throw new Error('Failed to fetch profile');
      const data = await response.json();
      setProfile({
        id: data.id,
        email: data.email,
        name: data.name,
        image: data.image,
        profile: data.profile,
        credentials: data.credentials,
        followerCount: data.followerCount ?? 0,
        followingCount: data.followingCount ?? 0,
        isFollowedByMe: data.isFollowedByMe ?? false,
      });
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      showMessage('Failed to load profile data', 'error');
    } finally {
      setLoading(false);
    }
  }, [userId, showMessage]);

  const fetchLogbook = useCallback(async (boardType: string) => {
    setLoadingStats(true);
    try {
      const client = createGraphQLHttpClient(null);
      const variables: GetUserTicksQueryVariables = { userId, boardType };
      const response = await client.request<GetUserTicksQueryResponse>(GET_USER_TICKS, variables);
      const entries: LogbookEntry[] = response.userTicks.map((tick) => ({
        climbed_at: tick.climbedAt,
        difficulty: tick.difficulty,
        tries: tick.attemptCount,
        angle: tick.angle,
        status: tick.status,
        climbUuid: tick.climbUuid,
      }));
      setLogbook(entries);
    } catch (error) {
      console.error('Error fetching ticks:', error);
      showMessage('Failed to load climbing stats', 'error');
      setLogbook([]);
    } finally {
      setLoadingStats(false);
    }
  }, [userId, showMessage]);

  const fetchAllBoardsTicks = useCallback(async () => {
    setLoadingAggregated(true);
    try {
      const client = createGraphQLHttpClient(null);
      const results: Record<string, LogbookEntry[]> = {};
      await Promise.all(
        BOARD_TYPES.map(async (boardType) => {
          const variables: GetUserTicksQueryVariables = { userId, boardType };
          const response = await client.request<GetUserTicksQueryResponse>(GET_USER_TICKS, variables);
          results[boardType] = response.userTicks.map((tick) => ({
            climbed_at: tick.climbedAt,
            difficulty: tick.difficulty,
            tries: tick.attemptCount,
            angle: tick.angle,
            status: tick.status,
            layoutId: tick.layoutId,
            boardType,
            climbUuid: tick.climbUuid,
          }));
        }),
      );
      setAllBoardsTicks(results);
    } catch (error) {
      console.error('Error fetching all boards ticks:', error);
      setAllBoardsTicks({});
    } finally {
      setLoadingAggregated(false);
    }
  }, [userId]);

  const fetchProfileStats = useCallback(async () => {
    setLoadingProfileStats(true);
    try {
      const client = createGraphQLHttpClient(null);
      const variables: GetUserProfileStatsQueryVariables = { userId };
      const response = await client.request<GetUserProfileStatsQueryResponse>(GET_USER_PROFILE_STATS, variables);
      setProfileStats(response.userProfileStats);
    } catch (error) {
      console.error('Error fetching profile stats:', error);
      setProfileStats(null);
    } finally {
      setLoadingProfileStats(false);
    }
  }, [userId]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);
  useEffect(() => { fetchAllBoardsTicks(); }, [fetchAllBoardsTicks]);
  useEffect(() => { fetchProfileStats(); }, [fetchProfileStats]);
  useEffect(() => { if (selectedBoard) fetchLogbook(selectedBoard); }, [selectedBoard, fetchLogbook]);

  const filteredLogbook = useMemo(
    () => filterLogbookByTimeframe(logbook, timeframe, fromDate, toDate),
    [logbook, timeframe, fromDate, toDate],
  );

  const aggregatedStackedBars = useMemo(
    () => buildAggregatedStackedBars(allBoardsTicks, aggregatedTimeframe),
    [allBoardsTicks, aggregatedTimeframe],
  );

  const weeklyBars = useMemo(
    () => buildWeeklyBars(filteredLogbook, weeklyFromDate || undefined, weeklyToDate || undefined),
    [filteredLogbook, weeklyFromDate, weeklyToDate],
  );

  const aggregatedFlashRedpointBars = useMemo(
    () => buildAggregatedFlashRedpointBars(allBoardsTicks, aggregatedTimeframe),
    [allBoardsTicks, aggregatedTimeframe],
  );

  const statisticsSummary = useMemo(
    () => buildStatisticsSummary(profileStats),
    [profileStats],
  );

  return {
    // Profile state
    loading,
    notFound,
    profile,
    setProfile,
    isOwnProfile,
    hasCredentials,
    authToken,

    // Board selection
    selectedBoard,
    setSelectedBoard,

    // Board stats
    loadingStats,
    filteredLogbook,
    timeframe,
    setTimeframe,
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    weeklyBars,
    weeklyFromDate,
    setWeeklyFromDate,
    weeklyToDate,
    setWeeklyToDate,

    // Aggregated stats
    aggregatedTimeframe,
    setAggregatedTimeframe,
    loadingAggregated,
    aggregatedStackedBars,
    aggregatedFlashRedpointBars,

    // Profile stats summary
    loadingProfileStats,
    statisticsSummary,

    // Tabs
    activeTab,
    setActiveTab,
  };
}
