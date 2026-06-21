import { and, desc, eq, lt } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  ConnectionContext,
  BoardPresenceClimb,
  BoardPresenceStats,
  BoardConnectionHolder,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../../../pubsub/index';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';
import { requireActiveBoardById, requireAnonReadableBoard, resolveBoardHolder } from './shared';
import { computeBoardPresenceStats } from './stats';

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
    await requireActiveBoardById(boardId);
    // Anonymous viewers only backfill public / system-shared boards.
    await requireAnonReadableBoard(boardId, ctx.userId);
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
   */
  boardHistory: async (
    _: unknown,
    { boardId, limit, before }: { boardId: number; limit?: number | null; before?: string | null },
    ctx: ConnectionContext,
  ): Promise<BoardPresenceClimb[]> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'boardHistory');
    await requireActiveBoardById(boardId);

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
   * Durable stats for a board's wall feed, derived from `boardsesh_ticks`
   * stamped with this board_id.
   *
   * Includes the representative hardest send so the board sheet can show the
   * climber + climb that established the wall's hardest logged grade.
   */
  boardPresenceStats: async (
    _: unknown,
    { boardId }: { boardId: number },
    ctx: ConnectionContext,
  ): Promise<BoardPresenceStats> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'boardPresenceStats');
    const board = await requireActiveBoardById(boardId);
    return computeBoardPresenceStats(boardId, board.boardType);
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
    await applyRateLimit(ctx, 30, 'boardConnection');
    // Validates the id and, for anonymous viewers, restricts to public /
    // system-shared boards.
    await requireAnonReadableBoard(boardId, ctx.userId);
    return resolveBoardHolder(boardId);
  },
};
