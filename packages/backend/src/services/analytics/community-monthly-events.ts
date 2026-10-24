import {
  COMMUNITY_TOP_LIST_SIZE,
  type CommunityClimberRank,
  type CommunityEmptyMonth,
  type CommunityGymRank,
  type CommunityMonth,
} from '../community-monthly-stats';
import { deterministicEventUuid } from './deterministic-event-uuid';

/**
 * The `Community Monthly Summary` / `Community Monthly Rank` reporting contract
 * behind the PostHog "Community: monthly recap" dashboard. Definitions live
 * with the numbers (`services/community-monthly-stats.ts`) and in
 * docs/growth-metrics.md ("Community monthly recap"); this file pins how they
 * travel:
 *
 * - one fixed non-person actor, `system:community-monthly`;
 * - each event dated to noon UTC on the 1st of its month, so a trend by month
 *   lines up with the month it measures, not the morning it was sent;
 * - a deterministic uuid per (month, summary) and per (month, list, rank), so
 *   every re-emit of a month is the same set of events. A query can still see
 *   more than one copy of a uuid until PostHog's storage merges them, so
 *   consumers dedupe by uuid and keep the newest `created_at`, which is the
 *   latest measurement;
 * - exactly {@link COMMUNITY_TOP_LIST_SIZE} rank rows per list per month,
 *   padded with `empty: true`, so a list that shrinks overwrites its old
 *   bottom rows instead of leaving them behind. A month with no lighting sends
 *   no summary but still sends its 20 rows, all empty, so rows it held before
 *   (its boards since deleted) are overwritten too;
 * - scalar properties only, and never a user id, email, avatar or profile
 *   link. `climberName` is the one name, under the exception written in
 *   posthog.ts and docs/analytics-consent.md.
 */
export const COMMUNITY_MONTHLY_SUMMARY_EVENT = 'Community Monthly Summary' as const;
export const COMMUNITY_MONTHLY_RANK_EVENT = 'Community Monthly Rank' as const;

/** The actor for every recap event. Never a real id. */
export const COMMUNITY_MONTHLY_DISTINCT_ID = 'system:community-monthly' as const;

export type CommunityRankList = 'gyms' | 'climbers';

type ScalarProperties = Record<string, string | number | boolean | null>;

export type CommunityMonthlyEvent = {
  event: typeof COMMUNITY_MONTHLY_SUMMARY_EVENT | typeof COMMUNITY_MONTHLY_RANK_EVENT;
  uuid: string;
  timestamp: Date;
  properties: ScalarProperties;
};

export function communityMonthlyEventUuid(month: string, list?: CommunityRankList, rank?: number): string {
  return deterministicEventUuid(
    list === undefined
      ? `boardsesh:community-monthly:${month}:summary`
      : `boardsesh:community-monthly:${month}:${list}:${rank}`,
  );
}

export function communityMonthlyEventTimestamp(month: string): Date {
  return new Date(`${month}-01T12:00:00.000Z`);
}

function gymRankProperties(gym: CommunityGymRank | undefined): ScalarProperties {
  return {
    empty: gym === undefined,
    gymName: gym?.gymName ?? null,
    gymSlug: gym?.gymSlug ?? null,
    climbers: gym?.climbers ?? null,
    climbsLit: gym?.climbsLit ?? null,
    boards: gym?.boards ?? null,
  };
}

function climberRankProperties(climber: CommunityClimberRank | undefined): ScalarProperties {
  return {
    empty: climber === undefined,
    climberName: climber?.climberName ?? null,
    named: climber === undefined ? null : climber.climberName !== null,
    sends: climber?.sends ?? null,
    flashes: climber?.flashes ?? null,
    sendDays: climber?.sendDays ?? null,
  };
}

/** Two ten-row lists, padded with empty rows. */
function rankEvents(
  { month, complete }: CommunityEmptyMonth,
  topGyms: readonly CommunityGymRank[],
  topClimbers: readonly CommunityClimberRank[],
): CommunityMonthlyEvent[] {
  const timestamp = communityMonthlyEventTimestamp(month);
  const monthEvents: CommunityMonthlyEvent[] = [];
  const lists: Array<[CommunityRankList, (rank: number) => ScalarProperties]> = [
    ['gyms', (rank) => gymRankProperties(topGyms.find((gym) => gym.rank === rank))],
    ['climbers', (rank) => climberRankProperties(topClimbers.find((climber) => climber.rank === rank))],
  ];
  for (const [list, rowProperties] of lists) {
    for (let rank = 1; rank <= COMMUNITY_TOP_LIST_SIZE; rank += 1) {
      monthEvents.push({
        event: COMMUNITY_MONTHLY_RANK_EVENT,
        uuid: communityMonthlyEventUuid(month, list, rank),
        timestamp,
        properties: { month, complete, list, rank, ...rowProperties(rank) },
      });
    }
  }
  return monthEvents;
}

/** One summary and two padded ten-row lists: 21 events for a month. */
export function buildCommunityMonthlyEvents(communityMonth: CommunityMonth): CommunityMonthlyEvent[] {
  const { month, complete, summary } = communityMonth;
  return [
    {
      event: COMMUNITY_MONTHLY_SUMMARY_EVENT,
      uuid: communityMonthlyEventUuid(month),
      timestamp: communityMonthlyEventTimestamp(month),
      properties: { month, complete, ...summary },
    },
    ...rankEvents(
      communityMonth,
      communityMonth.topGyms,
      // A retired month never carries a name, whatever the compute handed over.
      communityMonth.namesRetired
        ? communityMonth.topClimbers.map((climber) => ({ ...climber, climberName: null }))
        : communityMonth.topClimbers,
    ),
  ];
}

/**
 * A month with no lighting: no summary (no cohort, not zero), but all 20 rank
 * rows sent empty under their usual uuids, so nothing it sent before survives.
 */
export function buildCommunityEmptyMonthEvents(emptyMonth: CommunityEmptyMonth): CommunityMonthlyEvent[] {
  return rankEvents(emptyMonth, [], []);
}
