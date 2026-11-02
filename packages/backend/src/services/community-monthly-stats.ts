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
  /**
   * The climber's display name. Null when they set none, their account is
   * private, or they stay anonymous on boards they don't own; they keep their
   * rank either way.
   */
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

/** A month scanned with no lit climb: no cohort, so no summary and no ranked rows. */
export type CommunityEmptyMonth = {
  month: string;
  complete: boolean;
};

export type CommunityMonthlyStats = {
  /** Months with at least one lit climb, oldest first. */
  months: CommunityMonth[];
  /** Months scanned with no lit climb, oldest first. */
  skippedMonths: CommunityEmptyMonth[];
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

/**
 * A display name fit to publish, or null. Trimmed of Unicode whitespace, and
 * it must hold at least one letter or digit in any script: a name of tabs,
 * no-break spaces or zero-width characters would otherwise go out as an
 * invisible `climberName` with `named: true`. Checked here rather than with a
 * Postgres `[[:alnum:]]`, whose answer for non-Latin letters depends on the
 * database's collation (`'李'` fails under "C").
 */
export function publishableClimberName(displayName: string | null): string | null {
  const trimmed = displayName?.trim() ?? '';
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : null;
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
 * climber names removed. Four statements whatever the window's size, each one
 * scan grouped by month: lighting (totals and the gym ranking), sending
 * totals, the climber ranking, and new accounts. Read-only.
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

  // Lighting, in ONE scan of board_climb_events: the window's events grouped
  // to one row per (month, board, climber), which both the month's totals and
  // the gym ranking aggregate from. A climber who lit climbs on two boards is
  // two rows here, so distinct climbers stay distinct-counted downstream.
  const litMonthStart = sql`date_trunc('month', ${climbEvents.confirmedAt})`;
  const litByBoard = database.$with('community_lit').as(
    database
      .select({
        // Drizzle names a CTE's columns unqualified, so every alias is unique
        // across the statement (the gym boards subquery has its own board_id).
        monthStart: sql<string>`${litMonthStart}`.as('lit_month_start'),
        boardId: sql<number>`${climbEvents.boardId}`.as('lit_board_id'),
        climberId: sql<string | null>`${climbEvents.userId}`.as('lit_climber_id'),
        climbs: sql<number>`count(*)::int`.as('lit_climbs'),
      })
      .from(climbEvents)
      .where(
        and(
          eq(climbEvents.source, 'boardsesh'),
          gte(climbEvents.confirmedAt, startIso),
          lt(climbEvents.confirmedAt, endIso),
        ),
      )
      .groupBy(litMonthStart, climbEvents.boardId, climbEvents.userId),
  );
  const litTotals = database.$with('community_lit_totals').as(
    database
      .select({
        monthStart: litByBoard.monthStart,
        climbersWhoLit: sql<number>`count(distinct ${litByBoard.climberId})::int`.as('climbers_who_lit'),
        climbsLit: sql<number>`sum(${litByBoard.climbs})::int`.as('climbs_lit_total'),
        boardsLit: sql<number>`count(distinct ${litByBoard.boardId})::int`.as('boards_lit'),
      })
      .from(litByBoard)
      .groupBy(litByBoard.monthStart),
  );
  // Gyms: lighting on the gym's enumerable boards (public, listed, live), on
  // public undeleted gyms, and never on a spray wall an admin hid or its owner
  // deleted (ENUMERABLE_GYM_BOARDS reads user_boards alone). Ranked in SQL so
  // only the top rows travel; `gyms_in_month` rides on each for the summary.
  const gymClimbers = sql`count(distinct ${litByBoard.climberId})`;
  const gymClimbsLit = sql`sum(${litByBoard.climbs})`;
  const gymActivity = database.$with('community_gym_activity').as(
    database
      .select({
        monthStart: sql<string>`${litByBoard.monthStart}`.as('gym_month_start'),
        gymName: sql<string>`${gyms.name}`.as('gym_name'),
        gymSlug: sql<string | null>`${gyms.slug}`.as('gym_slug'),
        climbers: sql<number>`${gymClimbers}::int`.as('gym_climbers'),
        climbsLit: sql<number>`${gymClimbsLit}::int`.as('gym_climbs_lit'),
        boards: sql<number>`count(distinct ${litByBoard.boardId})::int`.as('gym_boards'),
        rank: sql<number>`(row_number() over (partition by ${litByBoard.monthStart} order by ${gymClimbers} desc, ${gymClimbsLit} desc, ${gyms.id} asc))::int`.as(
          'gym_rank',
        ),
        gymsInMonth: sql<number>`(count(*) over (partition by ${litByBoard.monthStart}))::int`.as('gyms_in_month'),
      })
      .from(litByBoard)
      .innerJoin(
        sql`(${ENUMERABLE_GYM_BOARDS}) AS community_gym_boards`,
        sql`community_gym_boards.board_id = ${litByBoard.boardId}`,
      )
      .innerJoin(
        gyms,
        and(
          eq(gyms.id, sql`community_gym_boards.gym_id`),
          isNull(gyms.deletedAt),
          gymVisibleCondition(gyms, null, true),
        ),
      )
      .where(
        sql`NOT EXISTS (SELECT 1 FROM spray_walls community_gym_wall
          JOIN user_boards community_gym_wall_board ON community_gym_wall_board.uuid = community_gym_wall.board_uuid
          WHERE community_gym_wall_board.id = community_gym_boards.board_id
            AND (community_gym_wall.hidden_at IS NOT NULL OR community_gym_wall.deleted_at IS NOT NULL))`,
      )
      .groupBy(litByBoard.monthStart, gyms.id),
  );
  // One row per (month, top gym), or one row with no gym for a month whose
  // lighting reached no ranked gym; every row carries its month's totals.
  const litRows = await database
    .with(litByBoard, litTotals, gymActivity)
    .select({
      month: sql<string>`to_char(${litTotals.monthStart}, 'YYYY-MM')`,
      climbersWhoLit: litTotals.climbersWhoLit,
      climbsLit: litTotals.climbsLit,
      boardsLit: litTotals.boardsLit,
      gymsInMonth: gymActivity.gymsInMonth,
      rank: gymActivity.rank,
      gymName: gymActivity.gymName,
      gymSlug: gymActivity.gymSlug,
      climbers: gymActivity.climbers,
      gymClimbsLit: gymActivity.climbsLit,
      boards: gymActivity.boards,
    })
    .from(litTotals)
    .leftJoin(
      gymActivity,
      and(eq(gymActivity.monthStart, litTotals.monthStart), lte(gymActivity.rank, COMMUNITY_TOP_LIST_SIZE)),
    )
    .orderBy(litTotals.monthStart, gymActivity.rank);
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
  // Named only by the display name they chose, on a public account, and not
  // anonymous on boards they don't own: a global ranking spans boards they
  // don't own, so that opt-out always applies. Deliberately stricter than the
  // board leaderboard, which falls back to the account name: that can be an
  // email's local part or a legal name from Google or Apple.
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
      >`CASE WHEN ${namedClimber} THEN NULLIF(btrim(${userProfiles.displayName}), '') END`,
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

  const litByMonth = new Map<string, typeof litRows>();
  for (const row of litRows) litByMonth.set(row.month, [...(litByMonth.get(row.month) ?? []), row]);
  const sendsByMonth = new Map(sendRows.map((row) => [row.month, row]));
  const accountsByMonth = new Map(accountRows.map((row) => [row.month, row.newAccounts]));

  const result: CommunityMonthlyStats = { months: [], skippedMonths: [] };
  for (const month of window.months) {
    const monthRows = litByMonth.get(month) ?? [];
    const [lit] = monthRows;
    const complete = monthIsComplete(month, now);
    // No cohort, not zero: a month nobody lit a climb in has no summary.
    if (!lit || lit.climbsLit === 0) {
      result.skippedMonths.push({ month, complete });
      continue;
    }
    const sends = sendsByMonth.get(month);
    const namesRetired = retiredMonths.has(month);
    result.months.push({
      month,
      complete,
      namesRetired,
      summary: {
        climbersWhoLit: lit.climbersWhoLit,
        climbsLit: lit.climbsLit,
        boardsLit: lit.boardsLit,
        gymsWithActivity: lit.gymsInMonth ?? 0,
        sendsLogged: sends?.sendsLogged ?? 0,
        climbersWhoLogged: sends?.climbersWhoLogged ?? 0,
        newAccounts: accountsByMonth.get(month) ?? 0,
      },
      topGyms: monthRows.flatMap(({ rank, gymName, gymSlug, climbers, gymClimbsLit, boards }) =>
        rank === null || gymName === null || climbers === null || gymClimbsLit === null || boards === null
          ? []
          : [{ rank, gymName, gymSlug, climbers, climbsLit: gymClimbsLit, boards }],
      ),
      topClimbers: climberRows
        .filter((row) => row.month === month)
        .map(({ rank, climberName, sends: sendCount, flashes, sendDays }) => ({
          rank,
          climberName: namesRetired ? null : publishableClimberName(climberName),
          sends: sendCount,
          flashes,
          sendDays,
        })),
    });
  }
  return result;
}
