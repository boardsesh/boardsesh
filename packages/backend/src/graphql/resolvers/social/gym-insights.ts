import { eq, and, or, isNull, inArray, count, asc, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { GymStatsInputSchema } from '../../../validation/schemas';
import {
  consensusGradeTable,
  consensusGradeJoinCondition,
  consensusDifficultyNameExpr,
} from '../shared/sql-expressions';
import { requireGymEditAccess } from './gyms';

// Reads share the gymBoards ceiling: an owner refreshing the Insights tab (or a
// wall of manage tabs behind one gym NAT) shouldn't outrun the limit, and the
// query sits behind the gym-edit gate anyway.
const RATE_LIMIT_GYM_STATS = 30;

// How many days each window spans, by period. The comparison window is always
// the equally-long span immediately before the current one.
const WINDOW_DAYS: Record<'week' | 'month', number> = { week: 7, month: 30 };

const TOP_CLIMBS_LIMIT = 10;

// flash + send only — an attempt isn't an ascent. Mirrors boardLeaderboard so
// the Insights numbers line up with the kiosk leaderboard rail.
const flashOrSend = or(eq(dbSchema.boardseshTicks.status, 'flash'), eq(dbSchema.boardseshTicks.status, 'send'))!;

type CountsRow = {
  currentUnique: number;
  currentAscents: number;
  previousUnique: number;
  previousAscents: number;
};

const emptyStats = (gymUuid: string, periodDays: number) => ({
  gymUuid,
  periodDays,
  current: { uniqueClimbers: 0, ascentCount: 0 },
  previous: { uniqueClimbers: 0, ascentCount: 0 },
  topClimbs: [],
  busiestDays: [],
});

export const socialGymInsightsQueries = {
  /**
   * A gym owner's activity snapshot: unique climbers, total ascents, the top-10
   * climbs, and busiest weekdays for the current window, plus the counts for the
   * equally-long window before it (for week-over-week deltas). Requires gym edit
   * access (owner, gym admin/editor, or a covering community admin/leader).
   *
   * Every aggregate is bounded to the gym's linked board ids AND a time window,
   * riding the `boardsesh_ticks_board_climbed_at_idx` (board_id, climbed_at)
   * index — the same filter shape boardLeaderboard uses, never an unbounded tick
   * scan. The scalar counts for both windows come from a SINGLE 2×-window scan
   * with FILTER clauses; top climbs and busiest days are computed for the current
   * window only (that's all the dashboard renders).
   */
  gymStats: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_GYM_STATS, 'gymStats');
    const { gymUuid, period } = validateInput(GymStatsInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Gate FIRST: a caller without edit access never reaches the tick tables.
    const gym = await requireGymEditAccess(gymUuid, userId);

    const windowDays = WINDOW_DAYS[period];

    // gym → boards traversal (the same join boardLeaderboard does per board, done
    // once for the whole gym). No linked boards → nothing to aggregate.
    const boardRows = await db
      .select({ id: dbSchema.userBoards.id })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.gymId, gym.id), isNull(dbSchema.userBoards.deletedAt)));
    const boardIds = boardRows.map((row) => row.id);
    if (boardIds.length === 0) {
      return emptyStats(gym.uuid, windowDays);
    }

    // Window boundaries. `make_interval(days => n)` keeps the day count a bound,
    // typed param (::int) rather than string-built SQL. currentStart splits the
    // 2×-window scan into "current" (>= currentStart) and "previous" (< it).
    const currentStart = sql`NOW() - make_interval(days => ${windowDays}::int)`;
    const outerStart = sql`NOW() - make_interval(days => ${windowDays * 2}::int)`;

    const inGymBoards = inArray(dbSchema.boardseshTicks.boardId, boardIds);
    // Day-of-week bucket is UTC: climbed_at is a naive (no-tz) timestamp and
    // EXTRACT(DOW) reads it verbatim, so there's no per-gym local-time shift — a
    // gym west of UTC sees a Friday-evening send land in Saturday's bucket. This
    // is the accepted v1 (no gym-timezone column exists yet); gym-local bucketing
    // is a possible follow-up. 0 = Sunday … 6 = Saturday.
    const dayOfWeekExpr = sql<number>`EXTRACT(DOW FROM ${dbSchema.boardseshTicks.climbedAt})::int`;

    const [countsRows, topClimbRows, busiestDayRows] = await Promise.all([
      // Both windows in one scan of the last 2×windowDays days.
      db
        .select({
          currentUnique: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId}) FILTER (WHERE ${dbSchema.boardseshTicks.climbedAt} >= ${currentStart})`,
          currentAscents: sql<number>`COUNT(*) FILTER (WHERE ${dbSchema.boardseshTicks.climbedAt} >= ${currentStart})`,
          previousUnique: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId}) FILTER (WHERE ${dbSchema.boardseshTicks.climbedAt} < ${currentStart})`,
          previousAscents: sql<number>`COUNT(*) FILTER (WHERE ${dbSchema.boardseshTicks.climbedAt} < ${currentStart})`,
        })
        .from(dbSchema.boardseshTicks)
        .where(and(inGymBoards, flashOrSend, sql`${dbSchema.boardseshTicks.climbedAt} >= ${outerStart}`)),

      // Top climbs (current window). Grade name falls back to null when the climb
      // has no catalog row or no consensus grade — the UI degrades gracefully.
      db
        .select({
          climbUuid: dbSchema.boardseshTicks.climbUuid,
          boardType: dbSchema.boardseshTicks.boardType,
          angle: dbSchema.boardseshTicks.angle,
          name: dbSchema.boardClimbs.name,
          gradeName: consensusDifficultyNameExpr,
          ascentCount: count(),
        })
        .from(dbSchema.boardseshTicks)
        .leftJoin(
          dbSchema.boardClimbs,
          and(
            eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbs.uuid),
            eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType),
          ),
        )
        .leftJoin(
          dbSchema.boardClimbStats,
          and(
            eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbStats.climbUuid),
            eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
            eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
          ),
        )
        .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
        .where(
          and(
            inGymBoards,
            flashOrSend,
            sql`${dbSchema.boardseshTicks.climbedAt} >= ${currentStart}`,
            // This is the only gym-insights query that returns a climb NAME, and
            // the resolver has no gym-membership check — so a personal spray wall
            // that happens to be attached to the gym would surface its climb names
            // to anyone who can read the gym's insights. A no-op on the other eight
            // board types. `null` viewer: membership is not established here, so
            // only a PUBLIC wall's names appear.
            sprayClimbVisibilityCondition(
              { boardType: dbSchema.boardClimbs.boardType, layoutId: dbSchema.boardClimbs.layoutId },
              null,
            ),
          ),
        )
        .groupBy(
          dbSchema.boardseshTicks.climbUuid,
          dbSchema.boardseshTicks.boardType,
          dbSchema.boardseshTicks.angle,
          dbSchema.boardClimbs.name,
          consensusGradeTable.boulderName,
        )
        // COUNT(*) DESC, then climb UUID for a deterministic tie order.
        .orderBy(sql`COUNT(*) DESC`, asc(dbSchema.boardseshTicks.climbUuid))
        .limit(TOP_CLIMBS_LIMIT),

      // Ascents per day of week (current window). Only non-empty days appear.
      db
        .select({ dayOfWeek: dayOfWeekExpr, ascentCount: count() })
        .from(dbSchema.boardseshTicks)
        .where(and(inGymBoards, flashOrSend, sql`${dbSchema.boardseshTicks.climbedAt} >= ${currentStart}`))
        .groupBy(dayOfWeekExpr)
        .orderBy(dayOfWeekExpr),
    ]);

    const counts = (countsRows[0] ?? {
      currentUnique: 0,
      currentAscents: 0,
      previousUnique: 0,
      previousAscents: 0,
    }) as CountsRow;

    return {
      gymUuid: gym.uuid,
      periodDays: windowDays,
      current: {
        uniqueClimbers: Number(counts.currentUnique),
        ascentCount: Number(counts.currentAscents),
      },
      previous: {
        uniqueClimbers: Number(counts.previousUnique),
        ascentCount: Number(counts.previousAscents),
      },
      topClimbs: topClimbRows.map((row) => ({
        climbUuid: row.climbUuid,
        boardType: row.boardType,
        angle: Number(row.angle),
        name: row.name ?? null,
        gradeName: row.gradeName ?? null,
        ascentCount: Number(row.ascentCount),
      })),
      busiestDays: busiestDayRows.map((row) => ({
        dayOfWeek: Number(row.dayOfWeek),
        ascentCount: Number(row.ascentCount),
      })),
    };
  },
};
