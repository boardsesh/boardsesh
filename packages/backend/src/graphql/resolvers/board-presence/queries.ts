import { and, asc, desc, eq, inArray, lt, max, or } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  BoardClimbRecentSender,
  ConnectionContext,
  BoardPresenceClimb,
  BoardPresenceStats,
  BoardConnectionHolder,
} from '@boardsesh/shared-schema';
import { resolveCanonicalClimbUuid } from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../../../pubsub/index';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { BoardClimbRecentSendersArgsSchema } from '../../../validation/schemas';
import { parsePostgresUtcTimestamp } from '../../../utils/postgres-timestamps';
import {
  assertAnonReadableBoard,
  requireActiveBoardWithVisibilityById,
  requireAnonReadableBoard,
  resolveBoardHolder,
} from './shared';
import { computeBoardPresenceStats, getCachedBoardPresenceStats, setCachedBoardPresenceStats } from './stats';

const RECENT_CLIMB_SENDERS_LIMIT = 5;
/**
 * Rows to ask Postgres for. Postgres applies the LIMIT, then we drop any row
 * whose `climbed_at` will not parse — so asking for exactly 5 would hand back 4
 * whenever a corrupt row landed in the top 5, with valid senders sitting just
 * under the cut and no way to reach them. Asking for a few extra absorbs that;
 * the result is sliced back to `RECENT_CLIMB_SENDERS_LIMIT`.
 */
const RECENT_CLIMB_SENDERS_FETCH_LIMIT = RECENT_CLIMB_SENDERS_LIMIT + 3;

export const boardPresenceQueries = {
  /**
   * Backfill the recent "now on the wall" history for a board from the Redis
   * FIFO (last ~50, 1-week window). Used by late joiners before the live
   * `boardNowPlaying` subscription takes over. Empty without Redis.
   *
   * Auth-optional: this is the backfill half of the live "now on the wall" feed,
   * which anonymous viewers are first-class for (same surface as
   * `boardNowPlaying` / `boardConnection`). Rate-limited and bounded to an
   * existing board; reads only the shared live feed, never private data.
   */
  boardRecentClimbs: async (
    _: unknown,
    { boardId }: { boardId: number },
    ctx: ConnectionContext,
  ): Promise<BoardPresenceClimb[]> => {
    await applyRateLimit(ctx, 60, 'boardRecentClimbs');
    // One by-id lookup covers both the existence check and the isPublic/ownerId
    // fields the anon gate below needs (anonymous viewers only backfill
    // public / system-shared boards), instead of two round-trips for the same
    // row on every anonymous request.
    assertAnonReadableBoard(await requireActiveBoardWithVisibilityById(boardId), ctx.userId);
    return pubsub.getRecentBoardClimbs(String(boardId));
  },

  /**
   * Durable history of what was pushed to a board, from `board_climb_events`
   * (survives past the 1-week Redis window). Newest-first, keyset-paged via
   * `before`: an opaque cursor that is the `seq` of the last row of the
   * previous page.
   *
   * Ordering and the cursor are both on `seq`, which is unique and monotonic
   * per board (`board_climb_events_board_seq_unique`). That makes paging
   * tie-free — ordering by the second-granular `confirmedAt` could put several
   * rows at the same timestamp, where a `confirmedAt`-only cursor would repeat
   * or skip rows across pages.
   *
   * Intentionally public: a board's send log is shared, leaderboard-style data,
   * so any authenticated user may read any active board's history (no
   * membership check). Proof-of-presence gates *writes* (see reportBoardClimb),
   * not reads. `boardRecentClimbs` is the hot 1-week cache for the same data.
   *
   * Auth-optional: anonymous viewers read this same shared history for
   * public / system-shared boards (same gate as `boardRecentClimbs` /
   * `boardConnection`); a private board is masked as NOT_FOUND for them, same
   * as a nonexistent board.
   */
  boardHistory: async (
    _: unknown,
    { boardId, limit, before }: { boardId: number; limit?: number | null; before?: string | null },
    ctx: ConnectionContext,
  ): Promise<BoardPresenceClimb[]> => {
    await applyRateLimit(ctx, 60, 'boardHistory');
    // One by-id lookup covers both the existence check and the isPublic/ownerId
    // fields the anon gate below needs (anonymous viewers only read public /
    // system-shared boards' history), instead of two round-trips for the same
    // row on every anonymous request.
    assertAnonReadableBoard(await requireActiveBoardWithVisibilityById(boardId), ctx.userId);

    // Parse + validate the cursor before it reaches SQL, so a malformed value
    // returns a clean error instead of a leaked Postgres parse error. Trim
    // first and require digits only: `Number()` coerces whitespace/odd inputs
    // (" " -> 0, "1e3" -> 1000, "0x10" -> 16), which would silently return a
    // wrong/empty page. A blank/whitespace cursor is treated as "no cursor".
    let beforeSeq: number | null = null;
    const trimmedCursor = before?.trim();
    if (trimmedCursor) {
      if (!/^\d+$/.test(trimmedCursor)) {
        throw new GraphQLError('Invalid history cursor', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      beforeSeq = Number(trimmedCursor);
    }

    const cappedLimit = Math.min(Math.max(limit ?? 50, 1), 100);
    const boardMatch = eq(dbSchema.boardClimbEvents.boardId, boardId);
    // Join the sender (nullable — a user can be deleted, leaving userId null) so
    // history rows carry the same display identity + profile link as the live
    // feed. Profile fields win over the auth-account name/image, matching the
    // attribution precedence in reportBoardClimb.
    const rows = await db
      .select({
        climbUuid: dbSchema.boardClimbEvents.climbUuid,
        name: dbSchema.boardClimbEvents.name,
        grade: dbSchema.boardClimbEvents.grade,
        frames: dbSchema.boardClimbEvents.frames,
        angle: dbSchema.boardClimbEvents.angle,
        setter: dbSchema.boardClimbEvents.setter,
        confirmedAt: dbSchema.boardClimbEvents.confirmedAt,
        seq: dbSchema.boardClimbEvents.seq,
        sentByUserId: dbSchema.boardClimbEvents.userId,
        senderName: dbSchema.users.name,
        senderImage: dbSchema.users.image,
        profileDisplayName: dbSchema.userProfiles.displayName,
        profileAvatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.boardClimbEvents)
      .leftJoin(dbSchema.users, eq(dbSchema.boardClimbEvents.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardClimbEvents.userId, dbSchema.userProfiles.userId))
      .where(beforeSeq !== null ? and(boardMatch, lt(dbSchema.boardClimbEvents.seq, beforeSeq)) : boardMatch)
      .orderBy(desc(dbSchema.boardClimbEvents.seq))
      .limit(cappedLimit);

    return rows.map((row) => ({
      climbUuid: row.climbUuid,
      queueItemUuid: null,
      name: row.name,
      grade: row.grade,
      gradeColor: null,
      frames: row.frames,
      angle: row.angle,
      setter: row.setter,
      sentByDisplayName: row.profileDisplayName ?? row.senderName ?? null,
      sentByAvatarUrl: row.profileAvatarUrl ?? row.senderImage ?? null,
      sentByUserId: row.sentByUserId ?? null,
      sentAt: row.confirmedAt,
      seq: Number(row.seq),
    }));
  },

  /**
   * The latest successful climbers for one climb on this physical wall.
   * "Recent" is deliberately a fixed, newest-first distinct-user cap rather
   * than a time window: a quiet wall still shows useful history, while the
   * response and avatar row stay bounded.
   *
   * Ticks can retain an Aurora/Kilter alias UUID after catalog deduplication,
   * so resolve the requested climb to its canonical UUID and include every
   * known alias. Angle is exact; mirror is intentionally not filtered because
   * BoardPresenceClimb does not currently carry mirror state.
   */
  boardClimbRecentSenders: async (
    _: unknown,
    { boardId, climbUuid, angle }: { boardId: number; climbUuid: string; angle: number },
    ctx: ConnectionContext,
  ): Promise<BoardClimbRecentSender[]> => {
    await applyRateLimit(ctx, 60, 'boardClimbRecentSenders');
    const board = await requireActiveBoardWithVisibilityById(boardId);
    assertAnonReadableBoard(board, ctx.userId);
    const validated = validateInput(BoardClimbRecentSendersArgsSchema, { climbUuid, angle }, 'recent senders');

    const canonicalClimbUuid = await resolveCanonicalClimbUuid(db, board.boardType, validated.climbUuid);
    // The alias fan-out stays a subquery rather than its own round-trip: a
    // merged climb can carry an unbounded number of aliases, and this way the
    // resolver is two DB calls per kiosk refresh instead of three.
    const aliasedClimbUuids = db
      .select({ aliasUuid: dbSchema.boardClimbAliases.aliasUuid })
      .from(dbSchema.boardClimbAliases)
      .where(
        and(
          eq(dbSchema.boardClimbAliases.boardType, board.boardType),
          eq(dbSchema.boardClimbAliases.canonicalUuid, canonicalClimbUuid),
        ),
      );
    const latestSentAt = max(dbSchema.boardseshTicks.climbedAt);

    const rows = await db
      .select({
        userId: dbSchema.boardseshTicks.userId,
        senderName: dbSchema.users.name,
        senderImage: dbSchema.users.image,
        profileDisplayName: dbSchema.userProfiles.displayName,
        profileAvatarUrl: dbSchema.userProfiles.avatarUrl,
        lastSentAt: latestSentAt,
      })
      .from(dbSchema.boardseshTicks)
      .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
      .where(
        and(
          eq(dbSchema.boardseshTicks.boardId, boardId),
          eq(dbSchema.boardseshTicks.boardType, board.boardType),
          or(
            eq(dbSchema.boardseshTicks.climbUuid, canonicalClimbUuid),
            inArray(dbSchema.boardseshTicks.climbUuid, aliasedClimbUuids),
          ),
          eq(dbSchema.boardseshTicks.angle, validated.angle),
          inArray(dbSchema.boardseshTicks.status, ['flash', 'send']),
        ),
      )
      .groupBy(
        dbSchema.boardseshTicks.userId,
        dbSchema.users.name,
        dbSchema.users.image,
        dbSchema.userProfiles.displayName,
        dbSchema.userProfiles.avatarUrl,
      )
      .orderBy(desc(latestSentAt), asc(dbSchema.boardseshTicks.userId))
      .limit(RECENT_CLIMB_SENDERS_FETCH_LIMIT);

    const senders = rows.flatMap((row) => {
      const lastSentAt = parsePostgresUtcTimestamp(row.lastSentAt);
      return lastSentAt
        ? [
            {
              userId: row.userId,
              displayName: row.profileDisplayName ?? row.senderName ?? null,
              avatarUrl: row.profileAvatarUrl ?? row.senderImage ?? null,
              lastSentAt,
            },
          ]
        : [];
    });
    return senders.slice(0, RECENT_CLIMB_SENDERS_LIMIT);
  },

  /**
   * Durable stats for a board's wall feed, derived from `boardsesh_ticks`
   * stamped with this board_id.
   *
   * Includes the representative hardest send so the board sheet can show the
   * climber + climb that established the wall's hardest logged grade.
   *
   * Cached for 60s (`boardsesh:board-stats:v1:{boardId}`, best-effort — a
   * Redis miss or outage just falls through to a fresh compute) since the
   * underlying aggregate scans every tick on the board. Every write path that
   * changes these stats (`saveTick` / `updateTick` / `deleteTick` via
   * `queueBoardStatsPublish`) refreshes the cache within its own debounce
   * window, so a cache hit is never more than ~60s + the debounce stale.
   *
   * Auth-optional: anonymous viewers read these same stats for public /
   * system-shared boards (same gate as `boardHistory` / `boardRecentClimbs`
   * / `boardConnection`); a private board is masked as NOT_FOUND for them,
   * same as a nonexistent board.
   */
  boardPresenceStats: async (
    _: unknown,
    { boardId }: { boardId: number },
    ctx: ConnectionContext,
  ): Promise<BoardPresenceStats> => {
    // Multiple gym TVs can sit behind one NAT and reconnect together after a
    // network blip, so this anon-tolerant read gets the higher 60/min budget.
    await applyRateLimit(ctx, 60, 'boardPresenceStats');
    // One by-id lookup covers both the existence check and the isPublic/ownerId
    // fields the anon gate below needs, instead of two round-trips for the
    // same row on every anonymous request.
    const board = await requireActiveBoardWithVisibilityById(boardId);
    // Anonymous viewers only read public / system-shared boards' stats.
    assertAnonReadableBoard(board, ctx.userId);

    const cached = await getCachedBoardPresenceStats(boardId);
    if (cached) return cached;

    const stats = await computeBoardPresenceStats(boardId, board.boardType);
    // NX (only-if-absent): this fire-and-forget write races the debounced
    // publish path, which could land a FRESHER snapshot between our compute
    // and this SET — NX keeps that one instead of rolling the cache back;
    // on a true miss it populates the key as before.
    setCachedBoardPresenceStats(boardId, stats, { onlyIfAbsent: true });
    return stats;
  },

  /**
   * The board's current connection holder (who's connected + writing now), or
   * null when free. Late-joiner initial state before the `boardNowPlaying` /
   * `BoardConnectionChanged` stream warms up. Auth-optional. Display identity is
   * adopted from the newest climb only when that climb was sent by this holder
   * (else just the userId is known); an anonymous holder (a `conn:` emitter) has
   * a null userId and null attribution (clients render a "?").
   */
  boardConnection: async (
    _: unknown,
    { boardId }: { boardId: number },
    ctx: ConnectionContext,
  ): Promise<BoardConnectionHolder | null> => {
    // Multiple gym TVs can sit behind one NAT and reconnect together after a
    // network blip, so this anon-tolerant read gets the higher 60/min budget.
    await applyRateLimit(ctx, 60, 'boardConnection');
    // Validates the id and, for anonymous viewers, restricts to public /
    // system-shared boards.
    await requireAnonReadableBoard(boardId, ctx.userId);
    return resolveBoardHolder(boardId);
  },
};
