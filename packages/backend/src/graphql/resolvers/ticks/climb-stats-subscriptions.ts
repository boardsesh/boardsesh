import { SUPPORTED_BOARDS, type ClimbStatsEvent, type ConnectionContext } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator } from '../shared/async-iterators';
import { decrementConnectionSubCount, incrementConnectionSubCount } from './connection-sub-counter';

const VALID_BOARD_TYPES = new Set<string>(SUPPORTED_BOARDS);

// Layout IDs are positive integers — Aurora's IDs start at 1, Boardsesh's
// auto-increment starts at 1 too. 0 is never a valid layout; treat it as
// garbage along with anything past the 1M ceiling.
const LAYOUT_ID_MIN = 1;
const LAYOUT_ID_MAX = 1_000_000;

export const climbStatsSubscriptions = {
  climbStatsUpdated: {
    subscribe: async function* (
      _: unknown,
      { boardType, layoutId }: { boardType: string; layoutId: number },
      ctx: ConnectionContext,
    ) {
      // Gate on auth: live stat updates are a logged-in-only affordance.
      // Anonymous clients keep the local optimistic-delta behavior — they
      // just don't receive server-pushed reconciliation. Closes the
      // anonymous DoS vector flagged in PR #2218 review.
      if (!ctx.isAuthenticated || !ctx.userId) {
        throw new Error('Authentication required for climb stats updates');
      }
      if (!VALID_BOARD_TYPES.has(boardType)) {
        throw new Error(`Invalid board type: ${boardType}`);
      }
      if (!Number.isInteger(layoutId) || layoutId < LAYOUT_ID_MIN || layoutId > LAYOUT_ID_MAX) {
        throw new Error(`Invalid layout id: ${layoutId}`);
      }

      // Cap concurrent subs per connection (throws when over the limit).
      // Wrap the iterator in try/finally so the counter always decrements
      // on unsubscribe / client disconnect.
      incrementConnectionSubCount(ctx.connectionId);
      try {
        const channelKey = `${boardType}:${layoutId}`;

        const asyncIterator = await createAsyncIterator<ClimbStatsEvent>((push) =>
          pubsub.subscribeClimbStats(channelKey, push),
        );

        for await (const event of asyncIterator) {
          yield { climbStatsUpdated: event };
        }
      } finally {
        decrementConnectionSubCount(ctx.connectionId);
      }
    },
  },
};
