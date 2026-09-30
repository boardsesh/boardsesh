import { sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { readThroughRedis } from '../../../utils/redis-read-through';

type CommunityStats = {
  climbersLast30Days: number;
  litLast30Days: number;
  computedAt: string;
};

/** Bump when the figures' definition changes. */
export const COMMUNITY_STATS_CACHE_KEY = 'community-stats:v1';

/**
 * One hour. These are rounded marketing numbers, and the hour turns ~400
 * full-table scans a day into 24, shared across every web instance and deploy.
 */
export const COMMUNITY_STATS_CACHE_TTL_SECONDS = 60 * 60;

/**
 * Two numbers the marketing site can state without qualifying them: how many
 * climbers pushed a climb to a real board in the last 30 days, and how many
 * climbs they lit.
 *
 * `board_climb_events` is the substrate rather than `boardsesh_ticks` or
 * `gym_activity_stats`:
 *
 *  - Ticks under-report their own history. Board attribution on a tick was
 *    below 1% before 2026-04, so a tick-based count would quietly shrink the
 *    further back it reached — the worst property a headline number can have.
 *  - `gym_activity_stats` is the right shape and is materialised nightly, but it
 *    is a CACHE keyed by gym, so a sum across it counts a climber once per gym
 *    they visit. For a per-gym ranking that is correct; for "how many climbers",
 *    it is inflation.
 *
 * Events are dwell-gated at ~60s of sustained presence before a row is written,
 * so app-swiping noise never lands in either figure, and every row is
 * board-linked by construction.
 *
 * No authentication. `created_at` is NOT indexed, so the read is a sequential
 * scan of the whole table (~120 MB) plus a sort for the DISTINCT — ~430 ms per
 * call on prod. The web caller's five-minute `unstable_cache` is per instance
 * and per build, and the resolver is public, so the cache lives here: one Redis
 * entry for everyone, and `computedAt` still says when the figures were taken.
 */
export const communityStatsQueries = {
  communityStats: async (): Promise<CommunityStats> =>
    readThroughRedis({
      key: COMMUNITY_STATS_CACHE_KEY,
      ttlSeconds: COMMUNITY_STATS_CACHE_TTL_SECONDS,
      label: 'CommunityStats',
      load: async () => {
        const [row] = await db
          .select({
            climbers: sql<number>`count(DISTINCT ${dbSchema.boardClimbEvents.userId})::int`,
            lit: sql<number>`count(*)::int`,
          })
          .from(dbSchema.boardClimbEvents)
          .where(sql`${dbSchema.boardClimbEvents.createdAt} > now() - interval '30 days'`);

        return {
          climbersLast30Days: row?.climbers ?? 0,
          litLast30Days: row?.lit ?? 0,
          computedAt: new Date().toISOString(),
        };
      },
    }),
};
