import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { getBoardHistory, isPairedToBoard, lookupUsername } from '../../../services/room-manager/board-room';
import { BoardHistoryQueryInputSchema } from '../../../validation/schemas/board-history';
import { serializeBoardHistoryEntry } from './serialize';

export const boardHistoryQueries = {
  /**
   * Paginated board history for a serial in reverse chronological order.
   * Soft-gated on the caller being paired to the board.
   */
  boardHistory: async (
    _: unknown,
    { boardSerial, limit, before }: { boardSerial: string; limit?: number; before?: string },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 60);
    requireAuthenticated(ctx);
    const userId = ctx.userId;
    if (!userId) {
      throw new GraphQLError('Authentication required', { extensions: { code: 'FORBIDDEN' } });
    }

    const parsed = validateInput(BoardHistoryQueryInputSchema, { boardSerial, limit, before }, 'boardHistory input');

    const paired = await isPairedToBoard(userId, parsed.boardSerial);
    if (!paired) {
      throw new GraphQLError('Not paired to this board', { extensions: { code: 'FORBIDDEN' } });
    }

    const rows = await getBoardHistory(parsed.boardSerial, {
      limit: parsed.limit ?? 50,
      before: parsed.before ? new Date(parsed.before) : undefined,
    });

    // Resolve usernames in a single pass. Most rows on a given board share a
    // small handful of users; cache by userId to avoid hammering the users
    // table with one SELECT per row.
    const cache = new Map<string, string | null>();
    const out = [];
    for (const row of rows) {
      let name = cache.get(row.userId);
      if (name === undefined) {
        name = await lookupUsername(row.userId);
        cache.set(row.userId, name);
      }
      out.push(serializeBoardHistoryEntry(row, name));
    }
    return out;
  },
};
