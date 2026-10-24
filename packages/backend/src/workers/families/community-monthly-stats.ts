import { z } from 'zod';
import { captureBackendEvent, flushBackendEvents } from '../../services/analytics/posthog';
import {
  buildCommunityEmptyMonthEvents,
  buildCommunityMonthlyEvents,
  COMMUNITY_MONTHLY_DISTINCT_ID,
} from '../../services/analytics/community-monthly-events';
import {
  COMMUNITY_MAX_MONTHS,
  COMMUNITY_MAX_RETIRE_MONTHS,
  computeCommunityMonthlyStats,
  type CommunityMonth,
} from '../../services/community-monthly-stats';
import { jobLogger } from './batch-job';
import type { BackgroundJobFamilyModule } from './types';

/**
 * The monthly community recap behind the PostHog "Community: monthly recap"
 * dashboard: per UTC month, lighting and sending totals, new accounts, the ten
 * busiest public gyms and the ten climbers with the most sends, sent as
 * personless events (`services/analytics/community-monthly-events.ts`,
 * docs/growth-metrics.md "Community monthly recap"). Nothing is written to the
 * database.
 *
 * Re-sent on purpose, under the same uuids: daily the current and previous
 * month (`months: 2`), every Monday the current month and the twelve before
 * it (`months: 13`). The current month fills in day by day, the previous one
 * settles once late lighting has landed, and a climber who goes private, turns
 * on anonymity or deletes their account drops out of every month in the
 * window within 7 days. The first Monday run is also the 12-month backfill.
 *
 * Names age out: the Monday run also re-sends the month just behind its
 * window (`retireMonths: 1`) with every climber name removed, so a name lives
 * in PostHog for at most the 13-month window plus a week. Each month sits in
 * that position for four or five Mondays, so one missed run does not leave
 * its names behind. After the family was off for longer, enqueue
 * `{"months":13,"retireMonths":N}` with N covering the weeks it missed.
 *
 * 07:30 UTC, after the nightly refreshes and the 07:15 snapshot export, so
 * the batch worker (one job at a time) is usually free.
 */
const payload = z
  .object({
    months: z.number().int().min(1).max(COMMUNITY_MAX_MONTHS).default(2),
    retireMonths: z.number().int().min(0).max(COMMUNITY_MAX_RETIRE_MONTHS).default(0),
    dryRun: z.boolean().default(false),
  })
  .strict()
  // Retiring a month inside the window would strip names the next weekly run
  // puts back; only months behind the full window can be retired.
  .refine(({ months, retireMonths }) => retireMonths === 0 || months === COMMUNITY_MAX_MONTHS, {
    message: `retireMonths needs months = ${COMMUNITY_MAX_MONTHS}`,
    path: ['retireMonths'],
  });

/** A dry run's log line: counts and ranks, never a climber's name. */
function describeMonth(communityMonth: CommunityMonth): string {
  const gyms = communityMonth.topGyms.map(
    (gym) => `${gym.rank}. ${gym.gymName} (${gym.climbers} climbers, ${gym.climbsLit} lit, ${gym.boards} boards)`,
  );
  const climbers = communityMonth.topClimbers.map(
    (climber) =>
      `${climber.rank}. ${climber.climberName === null ? '<anonymous>' : '<named>'} (${climber.sends} sends, ${climber.flashes} flashes, ${climber.sendDays} days)`,
  );
  const state = communityMonth.namesRetired ? ' (names retired)' : communityMonth.complete ? '' : ' (partial)';
  return `${communityMonth.month}${state}: ${JSON.stringify(communityMonth.summary)}; gyms: ${gyms.join('; ') || 'none'}; climbers: ${climbers.join('; ') || 'none'}`;
}

export const communityMonthlyStatsFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'community-monthly-stats',
  roles: ['batch'],
  options: {
    // Five read-only aggregate scans whatever the window. The weekly 13-month
    // run checks tick privacy per send row, so the lease leaves room for a
    // cold database; the deadline ends a run before the next day's is due.
    expireInSeconds: 900,
    retryLimit: 1,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 600,
    deadlineSeconds: 72_000,
    heartbeatSeconds: 300,
  },
  payload,
  // One key per window and retirement, so the Monday run never swallows (or
  // is swallowed by) a 2-month one, and a dry run never takes a real run's
  // place in the queue.
  singletonKey: ({ months, retireMonths, dryRun }) =>
    `${months}${retireMonths ? `+${retireMonths}` : ''}${dryRun ? ':dry-run' : ''}`,
  schedules: [
    {
      key: 'daily',
      cron: '30 7 * * 0,2-6',
      fanOut: async () => [{ payload: { months: 2, retireMonths: 0, dryRun: false } }],
    },
    {
      key: 'weekly',
      cron: '30 7 * * 1',
      fanOut: async () => [{ payload: { months: COMMUNITY_MAX_MONTHS, retireMonths: 1, dryRun: false } }],
    },
  ],
  async execute(context, { months, retireMonths, dryRun }) {
    const log = jobLogger(context);
    const stats = await computeCommunityMonthlyStats({
      database: context.database,
      now: new Date(),
      months,
      retireMonths,
      signal: context.signal,
    });
    const skipped = stats.skippedMonths.length
      ? `; no lit climbs, rank rows cleared: ${stats.skippedMonths.map(({ month }) => month).join(', ')}`
      : '';
    if (dryRun) {
      for (const communityMonth of stats.months) {
        log.info(`community-monthly-stats dry-run ${describeMonth(communityMonth)}`);
      }
      log.info(`community-monthly-stats dry-run: ${stats.months.length} months measured, nothing emitted${skipped}`);
      return;
    }
    let attempted = 0;
    let captured = 0;
    const monthEvents = [
      ...stats.months.flatMap(buildCommunityMonthlyEvents),
      // No summary for a month with no lighting, but its rank rows go out
      // empty, so named rows it held before cannot outlive its boards.
      ...stats.skippedMonths.flatMap(buildCommunityEmptyMonthEvents),
    ];
    for (const monthEvent of monthEvents) {
      attempted += 1;
      const queued = captureBackendEvent(monthEvent.event, {
        systemDistinctId: COMMUNITY_MONTHLY_DISTINCT_ID,
        properties: monthEvent.properties,
        timestamp: monthEvent.timestamp,
        uuid: monthEvent.uuid,
      });
      if (queued) captured += 1;
    }
    // Up to 294 events land at once on a Monday; send them now rather than
    // leaving the tail in the client's queue for a worker restart to drop.
    if (captured > 0) await flushBackendEvents();
    // Nothing captured is analytics disabled (dev, no key, non-production
    // env): the months measured themselves, so the run succeeds regardless.
    log.info(
      captured === 0 && attempted > 0
        ? `community-monthly-stats measured ${stats.months.length} months; analytics disabled, nothing emitted${skipped}`
        : `community-monthly-stats emitted ${captured} of ${attempted} events for ${stats.months.length} months${skipped}`,
    );
  },
};
