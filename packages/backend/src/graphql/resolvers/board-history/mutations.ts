import { GraphQLError } from 'graphql';
import { eq } from 'drizzle-orm';
import type { ConnectionContext, RecordBoardSendInput, BoardSession } from '@boardsesh/shared-schema';
import { boardSessions } from '@boardsesh/db/schema/app';
import { db } from '../../../db/client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { roomManager } from '../../../services/room-manager';
import { pubsub } from '../../../pubsub/index';
import {
  RecordBoardSendInputSchema,
  SetSharedPlaylistEnabledInputSchema,
} from '../../../validation/schemas/board-history';
import { appendBoardHistoryEntry, lookupUsername } from '../../../services/room-manager/board-room';
import { logger } from '../../../utils/logger';
import { graphqlSourceToDb, serializeBoardHistoryEntry } from './serialize';

/**
 * Throw a GraphQL FORBIDDEN error using a consistent shape clients can
 * pattern-match on.
 */
function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}

export const boardHistoryMutations = {
  /**
   * Record a successful board send. Idempotent on `input.uuid`.
   *
   * - Requires authentication.
   * - Persists to `board_climb_history` via the room-manager's board-room
   *   module (handles sequence allocation + Redis hot-state).
   * - Publishes a `BoardHistoryEntryAdded` event to the board-history
   *   channel ONLY when the row was freshly inserted. A duplicate uuid
   *   returns the existing row without re-publishing — that's the contract
   *   the client retry logic relies on.
   *
   * Note: we intentionally do NOT enforce the soft pairing gate here. The
   * write path is "this user just successfully sent to this serial via
   * BLE", which IS the moment pairing is established. Pairing is gated on
   * the subscription/query side instead.
   */
  recordBoardSend: async (_: unknown, { input }: { input: RecordBoardSendInput }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx);
    requireAuthenticated(ctx);
    const userId = ctx.userId;
    if (!userId) {
      throw forbidden('Authentication required');
    }

    // Normalise the GraphQL enum (UPPER_SNAKE) → DB enum (lower_snake)
    // before validation so the zod schema gets the DB-shaped values.
    const parsed = validateInput(
      RecordBoardSendInputSchema,
      {
        ...input,
        source: graphqlSourceToDb(input.source),
        isMirror: input.isMirror ?? false,
      },
      'recordBoardSend input',
    );

    const { persisted, inserted } = await appendBoardHistoryEntry(parsed.boardSerial, {
      uuid: parsed.uuid,
      boardId: parsed.boardId ?? null,
      userId,
      climbUuid: parsed.climbUuid,
      // boardType + layoutId aren't derivable from the input. We require them
      // for the table NOT NULL constraint but the client doesn't carry them.
      // Use empty / 0 placeholders — these columns are denormalised filter
      // helpers, not relied on for correctness. A follow-up could plumb them
      // through if a per-board-type filter ships.
      boardType: '',
      layoutId: 0,
      angle: parsed.angle,
      isMirror: parsed.isMirror ?? false,
      frames: parsed.frames ?? null,
      source: parsed.source,
      sessionId: parsed.sessionId ?? null,
      sharedPlaylistMode: parsed.sharedPlaylistMode,
    });

    const username = await lookupUsername(persisted.userId);
    const entry = serializeBoardHistoryEntry(persisted, username);

    if (inserted) {
      pubsub.publishBoardHistoryEvent(parsed.boardSerial, {
        __typename: 'BoardHistoryEntryAdded',
        sequence: entry.sequence,
        entry,
      });
    } else {
      logger.info(
        `[recordBoardSend] Duplicate uuid ${parsed.uuid.slice(0, 8)} for serial ${parsed.boardSerial}; returning existing row, no publish`,
      );
    }

    return entry;
  },

  /**
   * Toggle the shared-playlist queue model for a session.
   *
   * Restricted to the current session leader. The plan calls out
   * `getSessionLeaderConnectionId` as the source of truth — we match the
   * pattern used by `endSession` (reject when no current leader, fail
   * closed on stale reads).
   *
   * After persisting, publishes a `SharedPlaylistToggled` session event so
   * connected peers re-route their queue mutations between WS (shared) and
   * local IDB (local-only) without reconnecting. The leader still owns the
   * authoritative DB row; peers update their local `activeSession` cache
   * from the event.
   */
  setSharedPlaylistEnabled: async (
    _: unknown,
    { sessionId, enabled }: { sessionId: string; enabled: boolean },
    ctx: ConnectionContext,
  ): Promise<BoardSession> => {
    await applyRateLimit(ctx, 30);
    requireAuthenticated(ctx);

    const parsed = validateInput(
      SetSharedPlaylistEnabledInputSchema,
      { sessionId, enabled },
      'setSharedPlaylistEnabled input',
    );

    const sessionData = await roomManager.getSessionById(parsed.sessionId);
    if (!sessionData) {
      throw new GraphQLError('Session not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Leader-only. Creators are implicitly leaders at session start; only
    // tighten if there is a strong reason to allow non-leader participants
    // to flip the toggle.
    const isCreator = !!ctx.userId && sessionData.createdByUserId === ctx.userId;
    const leaderConnectionId = await roomManager.getSessionLeaderConnectionId(parsed.sessionId);
    const isLeader = leaderConnectionId !== null && leaderConnectionId === ctx.connectionId;
    if (!isCreator && !isLeader) {
      logger.warn(
        `[setSharedPlaylistEnabled] denied for session ${parsed.sessionId}: userId=${ctx.userId ?? 'none'}, isLeader=${isLeader}, isCreator=${isCreator}`,
      );
      throw forbidden('Only the session leader can change the shared playlist setting');
    }

    const updated = await db
      .update(boardSessions)
      .set({ sharedPlaylistEnabled: parsed.enabled })
      .where(eq(boardSessions.id, parsed.sessionId))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new GraphQLError('Session not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Broadcast the new value to every subscriber on the session channel.
    // Peers use this to switch their queue bridge between WS and local-IDB
    // adapters without reconnecting. Per the resolver's leader-only auth
    // above, the publish is safe — only authorized callers reach here.
    pubsub.publishSessionEvent(parsed.sessionId, {
      __typename: 'SharedPlaylistToggled',
      sessionId: parsed.sessionId,
      enabled: row.sharedPlaylistEnabled,
    });

    return {
      id: row.id,
      boardPath: row.boardPath,
      name: row.name,
      sharedPlaylistEnabled: row.sharedPlaylistEnabled,
      startedAt: row.startedAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
    };
  },
};
