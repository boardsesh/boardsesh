import { GraphQLError } from 'graphql';
import type { BoardHistoryEvent, ConnectionContext } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createEagerAsyncIterator } from '../shared/async-iterators';
import { getRecentHistoryForSync, isPairedToBoard, lookupUsername } from '../../../services/room-manager/board-room';
import { BoardHistorySerialSchema } from '../../../validation/schemas/board-history';
import { validateInput } from '../shared/helpers';
import { serializeBoardHistoryEntry } from './serialize';

export const boardHistorySubscriptions = {
  /**
   * Subscribe to real-time board history events for a serial.
   *
   * Mirrors the `queueUpdates` pattern:
   * 1. Soft pairing gate (caller must have a `userBoardSerials` row).
   * 2. Eager-subscribe to pubsub BEFORE fetching initial state — events
   *    that arrive in the gap are queued and filtered.
   * 3. Yield a `BoardHistoryFullSync` with the most recent entries.
   * 4. Forward incremental events whose `sequence > fullSyncSequence`.
   */
  boardHistoryEvents: {
    subscribe: async function* (_: unknown, { boardSerial }: { boardSerial: string }, ctx: ConnectionContext) {
      const userId = ctx.userId;
      if (!ctx.isAuthenticated || !userId) {
        throw new GraphQLError('Authentication required', { extensions: { code: 'FORBIDDEN' } });
      }

      const serial = validateInput(BoardHistorySerialSchema, boardSerial, 'boardSerial');

      const paired = await isPairedToBoard(userId, serial);
      if (!paired) {
        throw new GraphQLError('Not paired to this board', {
          extensions: { code: 'FORBIDDEN' } as const,
        });
      }

      // Subscribe FIRST so we don't miss events between the initial fetch
      // and the listener registration.
      const asyncIterator = await createEagerAsyncIterator<BoardHistoryEvent>((push) => {
        return pubsub.subscribeBoardHistory(serial, push);
      });

      // Then fetch the initial state. Queued events are filtered below.
      const { sequence: fullSyncSequence, entries } = await getRecentHistoryForSync(serial, 50);

      // Resolve usernames once for the initial batch.
      const cache = new Map<string, string | null>();
      const resolvedEntries = [];
      for (const row of entries) {
        let name = cache.get(row.userId);
        if (name === undefined) {
          name = await lookupUsername(row.userId);
          cache.set(row.userId, name);
        }
        resolvedEntries.push(serializeBoardHistoryEntry(row, name));
      }

      yield {
        boardHistoryEvents: {
          __typename: 'BoardHistoryFullSync' as const,
          sequence: Number(fullSyncSequence),
          entries: resolvedEntries,
        } satisfies BoardHistoryEvent,
      };

      const baseline = Number(fullSyncSequence);
      for await (const event of asyncIterator) {
        if (event.__typename === 'BoardHistoryFullSync') {
          // Only emitted by the initial sync; ignore if it ever shows up
          // on the bus.
          continue;
        }
        if (event.sequence > baseline) {
          yield { boardHistoryEvents: event };
        }
      }
    },
  },
};
