import {
  cachedUserClimbPercentile,
  cachedUserProfileStats,
  cachedUserTicks,
  serverUserProfileStats,
  serverUserTicks,
} from '@/app/lib/graphql/server-cached-client';
import { BOARD_TYPES } from '@boardsesh/profile-stats';
import type { LogbookEntry } from './utils/profile-constants';
import type {
  GetUserClimbPercentileQueryResponse,
  GetUserProfileStatsQueryResponse,
} from '@boardsesh/graphql/operations/ticks';

export type ProfileStatsData = {
  initialProfileStats: GetUserProfileStatsQueryResponse['userProfileStats'] | null;
  initialPercentile: GetUserClimbPercentileQueryResponse['userClimbPercentile'] | null;
  initialAllBoardsTicks: Record<string, LogbookEntry[]>;
  initialLogbook: LogbookEntry[];
};

export type FetchProfileStatsOptions = {
  /**
   * Skip the SSR data cache. Used by /you so the dashboard reflects a
   * just-logged tick immediately instead of waiting on the unstable_cache TTL.
   */
  skipCache?: boolean;
};

/**
 * Fetches profile stats and tick data for a user across all boards.
 * Shared between /you, /profile/[user_id], and /profile/[user_id]/statistics pages.
 */
export async function fetchProfileStatsData(
  userId: string,
  options: FetchProfileStatsOptions = {},
): Promise<ProfileStatsData> {
  const profileStatsFn = options.skipCache ? serverUserProfileStats : cachedUserProfileStats;
  const ticksFn = options.skipCache ? serverUserTicks : cachedUserTicks;

  // Percentile is a snapshot of the user's rank in a community-wide leaderboard;
  // a single new tick doesn't shift it. Always serve from the cache.
  const [initialProfileStats, initialPercentile, ...ticksResults] = await Promise.all([
    profileStatsFn(userId),
    cachedUserClimbPercentile(userId),
    ...BOARD_TYPES.map((boardType) => ticksFn(userId, boardType)),
  ]);

  const initialAllBoardsTicks: Record<string, LogbookEntry[]> = {};
  BOARD_TYPES.forEach((bt, i) => {
    const ticks = ticksResults[i];
    initialAllBoardsTicks[bt] = ticks
      ? ticks.map((tick) => ({
          climbed_at: tick.climbedAt,
          difficulty: tick.difficulty,
          effectiveDifficulty: tick.effectiveDifficulty ?? null,
          tries: tick.attemptCount,
          angle: tick.angle,
          status: tick.status as LogbookEntry['status'],
          layoutId: tick.layoutId,
          boardType: bt,
          climbUuid: tick.climbUuid,
        }))
      : [];
  });

  const initialLogbook = initialAllBoardsTicks['kilter'] ?? [];

  return { initialProfileStats, initialPercentile, initialAllBoardsTicks, initialLogbook };
}
