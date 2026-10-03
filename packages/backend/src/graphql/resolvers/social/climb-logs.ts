import { and, desc, eq, ne, notExists, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';
import { GraphQLError } from 'graphql';
import type { ClimbLogsInput, ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { boardClimbRatingsJoinCondition } from '../shared/sql-expressions';
import {
  climbLogBaseSelection,
  climbLogConditions,
  resolveClimbLogUuid,
  sentStatusCondition,
  toClimbLogBase,
} from './climb-log-query';
import { ClimbLogsInputSchema } from '../../../validation/schemas';
import { decodeClimbLogsCursor, encodeClimbLogsCursor, type ClimbLogsCursor } from '../../../utils/climb-logs-cursor';
import { logger } from '../../../utils/logger';

type TicksTable = typeof dbSchema.boardseshTicks;

type ClimbLogFilters = {
  angle?: number | null;
  withNotes?: boolean | null;
  sendsOnly?: boolean | null;
  excludeFollowed?: boolean | null;
};

/**
 * The optional filters, as conditions on `ticks`. They go in the SAME array as
 * `climbLogConditions`, so on the one-row-per-climber path they narrow the rows
 * BEFORE the newest one per climber is picked.
 */
function climbLogFilterConditions(
  ticks: TicksTable,
  { angle, withNotes, sendsOnly, excludeFollowed }: ClimbLogFilters,
  viewerUserId: string | null,
): SQL[] {
  const conditions: SQL[] = [];
  if (angle != null) conditions.push(eq(ticks.angle, angle));
  if (sendsOnly) conditions.push(sentStatusCondition(ticks));
  // A regex, not btrim: btrim only strips spaces, and a note of newlines or
  // tabs is still no note. A null comment is no match.
  if (withNotes) conditions.push(sql`${ticks.comment} ~ '\\S'`);
  // Needs somebody to exclude FOR: an anonymous caller follows nobody and has
  // no logs of their own, so the flag does nothing for them.
  if (excludeFollowed && viewerUserId) {
    conditions.push(
      ne(ticks.userId, viewerUserId),
      notExists(
        db
          .select({ one: sql`1` })
          .from(dbSchema.userFollows)
          .where(
            and(eq(dbSchema.userFollows.followerId, viewerUserId), eq(dbSchema.userFollows.followingId, ticks.userId)),
          ),
      ),
    );
  }
  return conditions;
}

/**
 * Rows strictly after the cursor in `(climbed_at desc, id desc)` order, as one
 * row comparison. Both values are bound as text and cast, so neither goes
 * through a driver type guess: the timestamp stays the string the column gave
 * back and the id never becomes a JS number.
 */
function afterCursor(climbedAt: AnyColumn, id: AnyColumn, cursor: ClimbLogsCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${climbedAt}, ${id}) < (${cursor.climbedAt}::timestamp, ${cursor.id.toString()}::bigint)`;
}

type ClimbLogsQueryArgs = {
  boardType: string;
  /** From `resolveClimbLogUuid`, not the caller's raw input. */
  canonicalClimbUuid: string;
  /** Null for an anonymous caller, never a hopeful id. */
  viewerUserId: string | null;
  filters: ClimbLogFilters;
  latestPerClimber: boolean;
  limit: number;
  cursor: ClimbLogsCursor | null;
};

/**
 * The one statement behind a page of `climbLogs`, asking for `limit + 1` rows
 * so the caller can tell whether another page exists.
 *
 * Exported unexecuted so its SQL can be read without a database: by
 * `climb-logs-sql.test.ts`, which checks where the privacy predicate sits on
 * each path, and by anyone running EXPLAIN on it.
 */
export function buildClimbLogsQuery({
  boardType,
  canonicalClimbUuid,
  viewerUserId,
  filters,
  latestPerClimber,
  limit,
  cursor,
}: ClimbLogsQueryArgs) {
  const ticks = dbSchema.boardseshTicks;

  // Board, climb, Aurora's duplicate rows and spray-wall visibility come from
  // climb-log-query.ts, the one copy of those rules. The filters ride in the
  // same array.
  const conditionsOn = (table: TicksTable): SQL[] => [
    ...climbLogConditions({ boardType, canonicalClimbUuid, viewerUserId, ticks: table }),
    ...climbLogFilterConditions(table, filters, viewerUserId),
  ];

  // On both paths, names, avatars and the synced-rating fallback are joined on
  // the page of rows only, never on every log of the climb.
  if (!latestPerClimber) {
    return db
      .select(climbLogBaseSelection)
      .from(ticks)
      .innerJoin(dbSchema.users, eq(ticks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(ticks.userId, dbSchema.userProfiles.userId))
      .leftJoin(dbSchema.boardClimbRatings, boardClimbRatingsJoinCondition)
      .where(and(...conditionsOn(ticks), afterCursor(ticks.climbedAt, ticks.id, cursor)))
      .orderBy(desc(ticks.climbedAt), desc(ticks.id))
      .limit(limit + 1);
  }

  // Rank each climber's logs newest first. The privacy and twin filters sit
  // INSIDE the window's WHERE, so a hidden or duplicate row can neither be
  // picked nor push a climber's real newest log out.
  const rankedLog = aliasedTable(ticks, 'ranked_log');
  const ranked = db
    .select({
      id: rankedLog.id,
      climbedAt: rankedLog.climbedAt,
      climberRank:
        sql<number>`row_number() over (partition by ${rankedLog.userId} order by ${rankedLog.climbedAt} desc, ${rankedLog.id} desc)`.as(
          'climber_rank',
        ),
    })
    .from(rankedLog)
    .where(and(...conditionsOn(rankedLog)))
    .as('ranked');

  // The cursor is applied AFTER the pick. Inside the window it would promote a
  // climber's older log once their newest fell before the cursor, and return
  // them twice.
  const page = db
    .select({ id: ranked.id })
    .from(ranked)
    .where(and(eq(ranked.climberRank, 1), afterCursor(ranked.climbedAt, ranked.id, cursor)))
    .orderBy(desc(ranked.climbedAt), desc(ranked.id))
    .limit(limit + 1)
    .as('page');

  return db
    .select(climbLogBaseSelection)
    .from(ticks)
    .innerJoin(page, eq(page.id, ticks.id))
    .innerJoin(dbSchema.users, eq(ticks.userId, dbSchema.users.id))
    .leftJoin(dbSchema.userProfiles, eq(ticks.userId, dbSchema.userProfiles.userId))
    .leftJoin(dbSchema.boardClimbRatings, boardClimbRatingsJoinCondition)
    .orderBy(desc(ticks.climbedAt), desc(ticks.id));
}

export const climbLogsQueries = {
  /**
   * Everyone's logs on one climb, newest first, one page at a time. Public:
   * signing in only widens which spray walls are visible and lets
   * `excludeFollowed` work.
   *
   * Every answer with nothing to show is the same answer. A spray climb on a
   * wall the caller cannot see, an unknown climb and a board type the uuid does
   * not belong to all return an empty page, never an error, so a private wall
   * is not observable through the shape of the response.
   */
  climbLogs: async (_: unknown, { input }: { input: ClimbLogsInput }, ctx: ConnectionContext) => {
    const validatedInput = validateInput(ClimbLogsInputSchema, input, 'input');
    await applyRateLimit(ctx, 60, 'climbLogs');

    // Outside the try block: a cursor nobody can decode is the caller's
    // mistake, not a DB error, and it must not quietly restart at page one.
    // Nullish, not falsy: an empty string is a cursor the caller sent, and it
    // decodes to nothing like any other broken one.
    const hasCursor = validatedInput.cursor != null;
    const cursor = hasCursor ? decodeClimbLogsCursor(validatedInput.cursor ?? '') : null;
    if (hasCursor && !cursor) {
      throw new GraphQLError('Invalid cursor', { extensions: { code: 'BAD_USER_INPUT' } });
    }

    // Null unless the request really is signed in. The privacy predicate reads
    // this, so a stale id on an unauthenticated context must not reach it.
    const viewerUserId = ctx.isAuthenticated ? (ctx.userId ?? null) : null;
    const { boardType, limit } = validatedInput;

    try {
      // The climb's canonical uuid, so logs stored under a uuid that was
      // deduplicated into this climb are found too.
      const canonicalClimbUuid = await resolveClimbLogUuid(boardType, validatedInput.climbUuid);
      const rows = await buildClimbLogsQuery({
        boardType,
        canonicalClimbUuid,
        viewerUserId,
        filters: validatedInput,
        latestPerClimber: validatedInput.latestPerClimber === true,
        limit,
        cursor,
      });

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const lastTick = pageRows.at(-1)?.tick;

      return {
        items: pageRows.map((row) => {
          // `isBenchmark` is part of the base mapper and not of ClimbLogItem.
          const { isBenchmark: _isBenchmark, ...item } = toClimbLogBase(row);
          return item;
        }),
        cursor: hasMore && lastTick ? encodeClimbLogsCursor({ climbedAt: lastTick.climbedAt, id: lastTick.id }) : null,
        hasMore,
      };
    } catch (err) {
      logger.error('[climbLogs] DB error:', err);
      throw err;
    }
  },
};
