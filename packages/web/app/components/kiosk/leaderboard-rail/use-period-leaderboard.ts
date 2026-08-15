'use client';

// Period leaderboard (Last 24 hours / week / month) for the kiosk rail: one
// anonymous HTTP `boardLeaderboard` query per scoped board, merged by user.
// React Query refetches every 60s so an unattended TV stays fresh.
//
// Deploy-order note: the 'day' period (rolling 24h) and anonymous access land
// with PR #3629, which merges ahead of this. Should this ever run against an
// older backend, every 'day' fetch rejects, the query errors, and the rail
// shows its "unavailable" copy (distinct from the no-sends empty state) —
// then self-heals via the refetch interval once the backend catches up. The
// period is deliberately NOT remapped client-side: labelling week data "Last
// 24 hours" (or silently swapping the configured window) would misrepresent
// the ranking.

import { useQuery } from '@tanstack/react-query';
import {
  GET_BOARD_LEADERBOARD,
  type GetBoardLeaderboardQueryResponse,
  type GetBoardLeaderboardQueryVariables,
} from '@boardsesh/graphql/operations';
import type { KioskLeaderboardPeriod } from '@boardsesh/kiosk';
import { executeGraphQL } from '@/app/lib/graphql/client';
import { mergeSettledPeriodLeaderboards, type KioskLeaderboardRowData } from './leaderboard-model';

export type KioskPeriodLeaderboardPeriod = Exclude<KioskLeaderboardPeriod, 'session'>;

/** Kiosk default: an unattended gym TV refreshes every minute. Embeds pass a
 * gentler interval (they run on arbitrary gym websites, one per visitor tab,
 * so their polling is deliberately rate-limit friendly). */
const PERIOD_REFETCH_MS = 60_000;
/** Per-board fetch depth: enough that a 10-row merged ranking can't miss a
 * climber who is mid-pack on every individual board. */
const PER_BOARD_FETCH_LIMIT = 50;

export type PeriodLeaderboardResult = {
  rows: KioskLeaderboardRowData[];
  isError: boolean;
  /** Epoch ms of the last successful fetch, for the rail footer. */
  updatedAtMs: number | null;
};

export function usePeriodLeaderboard(
  boardUuids: string[],
  period: KioskPeriodLeaderboardPeriod,
  enabled: boolean,
  options?: {
    /**
     * Keep polling while the tab is hidden. Default true — an unattended TV
     * must stay fresh. The manage-editor preview passes false so a forgotten
     * background tab doesn't poll the leaderboard all night.
     */
    refetchIntervalInBackground?: boolean;
    /** Override the 60s kiosk default — embeds poll more gently. */
    refetchIntervalMs?: number;
  },
): PeriodLeaderboardResult {
  const { data, isError, dataUpdatedAt } = useQuery({
    queryKey: ['kioskPeriodLeaderboard', period, boardUuids],
    enabled: enabled && boardUuids.length > 0,
    refetchInterval: options?.refetchIntervalMs ?? PERIOD_REFETCH_MS,
    refetchIntervalInBackground: options?.refetchIntervalInBackground ?? true,
    queryFn: async (): Promise<KioskLeaderboardRowData[]> => {
      const settled = await Promise.allSettled(
        boardUuids.map((boardUuid) =>
          executeGraphQL<GetBoardLeaderboardQueryResponse, GetBoardLeaderboardQueryVariables>(GET_BOARD_LEADERBOARD, {
            // `gymScreen` reads the climber's gym-screen consent rather than
            // their in-app one. A kiosk hangs on a wall inside the gym, which
            // climbers reasonably answer differently from an app a stranger can
            // open. Omitting this would publish names under the wrong consent —
            // the resolver defaults to the in-app column precisely so a caller
            // that forgets cannot over-publish.
            input: { boardUuid, period, limit: PER_BOARD_FETCH_LIMIT, surface: 'gymScreen' },
          }),
        ),
      );
      // Tolerates partial failure; throws when every board failed so the rail
      // shows its "unavailable" state instead of a fake empty ranking (see
      // mergeSettledPeriodLeaderboards — pure, unit-tested).
      return mergeSettledPeriodLeaderboards(settled);
    },
  });

  return {
    rows: data ?? [],
    isError,
    updatedAtMs: dataUpdatedAt > 0 ? dataUpdatedAt : null,
  };
}
