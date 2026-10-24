import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import type { JobDatabase } from '@boardsesh/db/jobs';
import { ENUMERABLE_GYM_BOARDS, NON_HUMAN_USER_IDS, userActivityVisibilityCondition } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { tickPrivacyCondition } from '../graphql/resolvers/shared/activity-privacy';
import { gymVisibleCondition } from '../graphql/resolvers/social/gym-visibility';

/**
 * The monthly community recap (the PostHog "Community: monthly recap"
 * dashboard): per UTC calendar month, how many climbers lit climbs on real
 * boards, the ten busiest public gyms and the ten climbers with the most
 * sends. PostHog has no Postgres connection, so the `community-monthly-stats`
 * batch family computes this here and sends it as personless events
 * (`services/analytics/community-monthly-events.ts`; contract in
 * docs/growth-metrics.md, "Community monthly recap").
 *
 * What leaves this module is counts, public gym names and slugs, and the names
 * of climbers a signed-out visitor would already see named on a board
 * leaderboard. No user id, email, avatar or profile link: the climbers'
 * ranking reads user ids to group and break ties, and drops them here.
 *
 * Lighting (`board_climb_events`, `source = 'boardsesh'`) is the activity
 * substrate, as in `communityStats`: every row is a climb a phone pushed to a
 * real board after ~60 s of presence, and it does not under-report its own
 * history the way board-attributed ticks do. Sends come from native ticks
 * (`origin = 'native'`), so an Aurora or Kilter logbook import is never
 * counted as Boardsesh activity in the month it was imported.
 *
 * Every timestamp column read here is `timestamp without time zone` holding
 * UTC wall-clock time, so `date_trunc('month', column)` is the UTC month
 * already. `AT TIME ZONE 'UTC'` on such a column would turn it INTO a
 * timestamptz and truncate in the session's zone instead.
 */

/** Rows per ranked list. The events pad every list to this many rows. */
export const COMMUNITY_TOP_LIST_SIZE = 10;

/** The widest window a run may cover: the current month plus twelve complete ones. */
export const COMMUNITY_MAX_MONTHS = 13;

/**
 * The most months a run may retire behind a full window. The weekly run
 * retires one; more is for catching up after the family was off for weeks.
 */
export const COMMUNITY_MAX_RETIRE_MONTHS = 12;

export type CommunityMonthSummary = {
  /** Distinct climbers behind a lit climb. */
  climbersWhoLit: number;
  /** Climbs pushed to a board's LEDs. */
  climbsLit: number;
  /** Distinct boards a climb was lit on. */
  boardsLit: number;
  /** Public, undeleted gyms with at least one lit climb on an enumerable gym board. */
  gymsWithActivity: number;
  /** Native flash and send ticks, by climbed-at. */
  sendsLogged: number;
  /** Distinct climbers behind those ticks. */
  climbersWhoLogged: number;
  /** Accounts created in the month, without the reserved system accounts. */
  newAccounts: number;
};

export type CommunityGymRank = {
  rank: number;
  gymName: string;
  gymSlug: string | null;
  /** Distinct climbers who lit a climb on the gym's boards. */
  climbers: number;
  climbsLit: number;
  /** Distinct gym boards a climb was lit on. */
  boards: number;
};

export type CommunityClimberRank = {
  rank: number;
  /** Null when the climber is private or anonymous on boards they don't own; they keep their rank. */
  climberName: string | null;
  sends: number;
  flashes: number;
  /** Distinct UTC days with a send. */
  sendDays: number;
};

export type CommunityMonth = {
  /** `YYYY-MM`, UTC. */
  month: string;
  /** False for the month that has not ended yet. */
  complete: boolean;
  /**
   * A month just behind the window, re-measured so its events can be re-sent
   * with every climber name removed: `climberName` is null on every row, the
   * counts and ranks are unchanged.
   */
  namesRetired: boolean;
  summary: CommunityMonthSummary;
  topGyms: CommunityGymRank[];
  topClimbers: CommunityClimberRank[];
};

export type CommunityMonthlyStats = {
  /** Months with at least one lit climb, oldest first. */
  months: CommunityMonth[];
  /** Months scanned with no lit climb: no cohort, so nothing is reported for them. */
  skippedMonths: string[];
};

export type ComputeCommunityMonthlyStatsOptions = {
  database: JobDatabase;
  now: Date;
  /** The current UTC month plus the `months - 1` before it. 1 to {@link COMMUNITY_MAX_MONTHS}. */
  months: number;
  /**
   * How many months just behind a full window to also measure with every
   * climber name removed (`namesRetired`), so names age out of PostHog instead
   * of staying on rows nothing re-sends. Only with a full window: retiring a
   * month inside it would strip names the weekly run puts back. Default 0.
   */
  retireMonths?: number;
  signal?: AbortSignal;
};

export type CommunityMonthWindow = {
  /** Every month in the window, oldest first, as `YYYY-MM`. */
  months: string[];
  /** The first instant of the oldest month. */
  start: Date;
  /** The first instant after the current month. */
  end: Date;
};

function utcMonthStart(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

function monthKey(monthStart: Date): string {
  return monthStart.toISOString().slice(0, 7);
}

/** The months a run covers: `now`'s UTC calendar month and the `months - 1` before it. */
export function communityMonthWindow(now: Date, months: number): CommunityMonthWindow {
  if (!Number.isInteger(months) || months < 1 || months > COMMUNITY_MAX_MONTHS) {
    throw new RangeError(`months must be an integer from 1 to ${COMMUNITY_MAX_MONTHS}, got ${months}`);
  }
  return monthsEndingAt(now, months);
}

/** `count` UTC calendar months ending with `now`'s, oldest first. */
function monthsEndingAt(now: Date, months: number): CommunityMonthWindow {
  const year = now.getUTCFullYear();
  const currentMonthIndex = now.getUTCMonth();
  const monthStarts = Array.from({ length: months }, (_, offset) =>
    utcMonthStart(year, currentMonthIndex - (months - 1) + offset),
  );
  return {
    months: monthStarts.map(monthKey),
    start: monthStarts[0],
    end: utcMonthStart(year, currentMonthIndex + 1),
  };
}

/** A month is complete once its last instant has passed. */
function monthIsComplete(month: string, now: Date): boolean {
  const [year, monthNumber] = month.split('-').map(Number);
  return utcMonthStart(year, monthNumber).getTime() <= now.getTime();
}

const climbEvents = dbSchema.boardClimbEvents;
const ticks = dbSchema.boardseshTicks;
const users = dbSchema.users;
const userProfiles = dbSchema.userProfiles;
const gyms = dbSchema.gyms;

/** The month of a `timestamp without time zone` column, as `YYYY-MM`. The format is inline, so a GROUP BY repeats it verbatim. */
function monthOf(column: SQLWrapper) {
  return sql<string>`to_char(date_trunc('month', ${column}), 'YYYY-MM')`;
}

/**
 * Compute every month in the window, plus `retireMonths` behind it with the
 * climber names removed. Five statements whatever the window's size, each one
 * scan grouped by month: lighting totals, the gym ranking, sending totals, the
 * climber ranking, and new accounts. Read-only.
 */
export async function computeCommunityMonthlyStats({
  database,
  now,
  months,
  retireMonths = 0,
  signal,
}: ComputeCommunityMonthlyStatsOptions): Promise<CommunityMonthlyStats> {
  communityMonthWindow(now, months);
  if (!Number.isInteger(retireMonths) || retireMonths < 0 || retireMonths > COMMUNITY_MAX_RETIRE_MONTHS) {
    throw new RangeError(
      `retireMonths must be an integer from 0 to ${COMMUNITY_MAX_RETIRE_MONTHS}, got ${retireMonths}`,
    );
  }
  if (retireMonths > 0 && months !== COMMUNITY_MAX_MONTHS) {
    throw new RangeError(`retireMonths needs the full ${COMMUNITY_MAX_MONTHS}-month window, got months=${months}`);
  }
  // The retired months are the oldest ones scanned, just behind the window.
  const window = monthsEndingAt(now, months + retireMonths);
  const retiredMonths = new Set(window.months.slice(0, retireMonths));
  // The tick and lit-event timestamps read as strings in the client, so their
  // bounds go out as ISO strings; `users.created_at` takes Dates.
  const startIso = window.start.toISOString();
  const endIso = window.end.toISOString();
  signal?.throwIfAborted();

  const litMonth = monthOf(climbEvents.confirmedAt);
  const litInWindow = and(
    eq(climbEvents.source, 'boardsesh'),
    gte(climbEvents.confirmedAt, startIso),
    lt(climbEvents.confirmedAt, endIso),
  );
  const litRows = await database
    .select({
      month: litMonth,
      climbersWhoLit: countDistinct(climbEvents.userId),
      climbsLit: count(),
      boardsLit: countDistinct(climbEvents.boardId),
    })
    .from(climbEvents)
    .where(litInWindow)
    .groupBy(litMonth);
  signal?.throwIfAborted();

  // Gyms: lit climbs on the gym's enumerable boards (public, listed, live),
  // public undeleted gyms only. Ranked in SQL so only the top rows travel;
  // `gyms_in_month` rides on each row for the summary's gym count.
  const gymMonthStart = sql`date_trunc('month', ${climbEvents.confirmedAt})`;
  const gymClimbers = sql`count(distinct ${climbEvents.userId})`;
  const gymClimbsLit = sql`count(*)`;
  const gymActivity = database
    .select({
      month: sql<string>`to_char(${gymMonthStart}, 'YYYY-MM')`.as('month'),
      gymName: sql<string>`${gyms.name}`.as('gym_name'),
      gymSlug: sql<string | null>`${gyms.slug}`.as('gym_slug'),
      climbers: sql<number>`${gymClimbers}::int`.as('climbers'),
      climbsLit: sql<number>`${gymClimbsLit}::int`.as('climbs_lit'),
      boards: sql<number>`count(distinct ${climbEvents.boardId})::int`.as('boards'),
      rank: sql<number>`(row_number() over (partition by ${gymMonthStart} order by ${gymClimbers} desc, ${gymClimbsLit} desc, ${gyms.id} asc))::int`.as(
        'gym_rank',
      ),
      gymsInMonth: sql<number>`(count(*) over (partition by ${gymMonthStart}))::int`.as('gyms_in_month'),
    })
    .from(climbEvents)
    .innerJoin(
      sql`(${ENUMERABLE_GYM_BOARDS}) AS community_gym_boards`,
      sql`community_gym_boards.board_id = ${climbEvents.boardId}`,
    )
    .innerJoin(
      gyms,
      and(eq(gyms.id, sql`community_gym_boards.gym_id`), isNull(gyms.deletedAt), gymVisibleCondition(gyms, null)),
    )
    .where(litInWindow)
    .groupBy(gymMonthStart, gyms.id)
    .as('community_gym_activity');
  const gymRows = await database
    .select()
    .from(gymActivity)
    .where(lte(gymActivity.rank, COMMUNITY_TOP_LIST_SIZE))
    .orderBy(gymActivity.month, gymActivity.rank);
  signal?.throwIfAborted();

  const sendInWindow = and(
    eq(ticks.origin, 'native'),
    inArray(ticks.status, ['flash', 'send']),
    gte(ticks.climbedAt, startIso),
    lt(ticks.climbedAt, endIso),
  );
  const sendMonth = monthOf(ticks.climbedAt);
  const sendRows = await database
    .select({ month: sendMonth, sendsLogged: count(), climbersWhoLogged: countDistinct(ticks.userId) })
    .from(ticks)
    .where(sendInWindow)
    .groupBy(sendMonth);
  signal?.throwIfAborted();

  // Climbers: only ticks a signed-out visitor may read count towards a rank
  // (account privacy, item audience, the climb's listing and spray-wall
  // rules), the same rows an anonymous board leaderboard counts. The user id
  // is the last tiebreak so the order is stable, and it stops at this query.
  const climberMonthStart = sql`date_trunc('month', ${ticks.climbedAt})`;
  const climberSends = sql`count(*)`;
  const climberFlashes = sql`count(*) filter (where ${ticks.status} = 'flash')`;
  const climberSendDays = sql`count(distinct (${ticks.climbedAt})::date)`;
  const climberActivity = database
    .select({
      month: sql<string>`to_char(${climberMonthStart}, 'YYYY-MM')`.as('month'),
      climberId: sql<string>`${ticks.userId}`.as('climber_id'),
      sends: sql<number>`${climberSends}::int`.as('sends'),
      flashes: sql<number>`${climberFlashes}::int`.as('flashes'),
      sendDays: sql<number>`${climberSendDays}::int`.as('send_days'),
      rank: sql<number>`(row_number() over (partition by ${climberMonthStart} order by ${climberSends} desc, ${climberFlashes} desc, ${climberSendDays} desc, ${ticks.userId} asc))::int`.as(
        'climber_rank',
      ),
    })
    .from(ticks)
    .where(and(sendInWindow, tickPrivacyCondition(null)))
    .groupBy(climberMonthStart, ticks.userId)
    .as('community_climber_activity');
  // The board-leaderboard naming rule for a signed-out viewer on a board the
  // climber does not own: a public account, not anonymous on foreign boards.
  // A global ranking spans boards they don't own, so the opt-out always applies.
  const namedClimber = and(
    userActivityVisibilityCondition(users.id, null),
    sql`${userProfiles.anonymousOnForeignBoards} IS NOT TRUE`,
  );
  const climberRows = await database
    .select({
      month: climberActivity.month,
      rank: climberActivity.rank,
      sends: climberActivity.sends,
      flashes: climberActivity.flashes,
      sendDays: climberActivity.sendDays,
      climberName: sql<
        string | null
      >`CASE WHEN ${namedClimber} THEN COALESCE(NULLIF(${userProfiles.displayName}, ''), NULLIF(${users.name}, '')) END`,
    })
    .from(climberActivity)
    .innerJoin(users, eq(users.id, climberActivity.climberId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(lte(climberActivity.rank, COMMUNITY_TOP_LIST_SIZE))
    .orderBy(climberActivity.month, climberActivity.rank);
  signal?.throwIfAborted();

  const accountMonth = monthOf(users.createdAt);
  const accountRows = await database
    .select({ month: accountMonth, newAccounts: count() })
    .from(users)
    .where(
      and(
        gte(users.createdAt, window.start),
        lt(users.createdAt, window.end),
        notInArray(users.id, [...NON_HUMAN_USER_IDS]),
      ),
    )
    .groupBy(accountMonth);

  const litByMonth = new Map(litRows.map((row) => [row.month, row]));
  const sendsByMonth = new Map(sendRows.map((row) => [row.month, row]));
  const accountsByMonth = new Map(accountRows.map((row) => [row.month, row.newAccounts]));

  const result: CommunityMonthlyStats = { months: [], skippedMonths: [] };
  for (const month of window.months) {
    const lit = litByMonth.get(month);
    // No cohort, not zero: a month nobody lit a climb in reports nothing.
    if (!lit || lit.climbsLit === 0) {
      result.skippedMonths.push(month);
      continue;
    }
    const monthGyms = gymRows.filter((row) => row.month === month);
    const sends = sendsByMonth.get(month);
    const namesRetired = retiredMonths.has(month);
    result.months.push({
      month,
      complete: monthIsComplete(month, now),
      namesRetired,
      summary: {
        climbersWhoLit: lit.climbersWhoLit,
        climbsLit: lit.climbsLit,
        boardsLit: lit.boardsLit,
        gymsWithActivity: monthGyms[0]?.gymsInMonth ?? 0,
        sendsLogged: sends?.sendsLogged ?? 0,
        climbersWhoLogged: sends?.climbersWhoLogged ?? 0,
        newAccounts: accountsByMonth.get(month) ?? 0,
      },
      topGyms: monthGyms.map(({ rank, gymName, gymSlug, climbers, climbsLit, boards }) => ({
        rank,
        gymName,
        gymSlug,
        climbers,
        climbsLit,
        boards,
      })),
      topClimbers: climberRows
        .filter((row) => row.month === month)
        .map(({ rank, climberName, sends: sendCount, flashes, sendDays }) => ({
          rank,
          climberName: namesRetired ? null : climberName,
          sends: sendCount,
          flashes,
          sendDays,
        })),
    });
  }
  return result;
}
