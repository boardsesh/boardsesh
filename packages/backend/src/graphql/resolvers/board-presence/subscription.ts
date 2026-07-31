import type { ConnectionContext, BoardPresenceEvent } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createEagerAsyncIterator } from '../shared/async-iterators';
import { applyRateLimit } from '../shared/helpers';
import { requireAnonReadableBoard } from './shared';

export const boardPresenceSubscriptions = {
  /**
   * Live "now on the wall" feed for a shared board. Auth-optional: board
   * presence is universal, so anonymous viewers are first-class (they need to
   * watch to see the holder + who's connected). A rate limit (so an anonymous
   * client can't loop board ids and grow the subscriber set unbounded) plus
   * `assertValidBoardId` bound it; it is otherwise membership-free — anyone who
   * can name the board_id may watch. Keyed on the shared board_id; no driver.
   *
   * Eager subscribe: `createEagerAsyncIterator` awaits the Redis channel
   * subscribe before the first yield so a `reportBoardClimb` that lands during
   * setup isn't dropped.
   */
  boardNowPlaying: {
    subscribe: async function* (_: unknown, { boardId }: { boardId: number }, ctx: ConnectionContext) {
      // Bumped to the same 60/min budget as the sibling anon-tolerant reads
      // for consistency. Since issue #2863 the WS context carries clientIp
      // (websocket/setup.ts resolves it from the upgrade request), so this
      // subscription shares the same anon `ip:` bucket as the HTTP-keyed reads
      // (boardConnection, boardPresenceStats) — the "multiple gym TVs behind
      // one NAT" caveat now applies here too. A TV re-subscribes on a config
      // poll rather than in a tight loop, so 60/min still leaves room for a
      // gym's worth of screens.
      await applyRateLimit(ctx, 60, 'boardNowPlaying');
      // Validates the id and, for anonymous viewers, restricts to public /
      // system-shared boards (not a private wall reached by enumerating ids);
      // logged-in callers are unbounded.
      await requireAnonReadableBoard(boardId, ctx.userId);

      const boardKey = String(boardId);

      const asyncIterator = await createEagerAsyncIterator<BoardPresenceEvent>(
        (push) => pubsub.subscribeBoardPresence(boardKey, push),
        `boardNowPlaying:${boardId}`,
      );

      for await (const event of asyncIterator) {
        yield { boardNowPlaying: event };
      }
    },
  },
};
