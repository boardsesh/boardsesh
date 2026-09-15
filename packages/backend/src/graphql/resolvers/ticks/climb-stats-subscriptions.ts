import { SUPPORTED_BOARDS, type ClimbStatsEvent, type ConnectionContext } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator, type CancellableAsyncIterator } from '../shared/async-iterators';
import { assertSprayBoardIsReadable } from '../climbs/spray-read-access';
import { requireAuthenticated } from '../shared/helpers';
import { acquireClimbStatsSubscription, releaseClimbStatsSubscription } from './climb-stats-subscription-counter';

const VALID_BOARD_TYPES = new Set<string>(SUPPORTED_BOARDS);
const MAX_LAYOUT_ID = 1_000_000;

type ClimbStatsSubscriptionPayload = { climbStatsUpdated: ClimbStatsEvent };

function mapClimbStatsIterator(
  source: CancellableAsyncIterator<ClimbStatsEvent>,
  releaseCapacity: () => void,
): CancellableAsyncIterator<ClimbStatsSubscriptionPayload> {
  let closed = false;
  let closePromise: Promise<IteratorResult<ClimbStatsSubscriptionPayload>> | null = null;
  const completedResult = (): IteratorResult<ClimbStatsSubscriptionPayload> => ({
    value: undefined as unknown as ClimbStatsSubscriptionPayload,
    done: true,
  });

  const close = (_value?: unknown): Promise<IteratorResult<ClimbStatsSubscriptionPayload>> => {
    if (closePromise) return closePromise;
    closed = true;
    // Release the connection slot as soon as graphql-ws asks the iterator to
    // stop. The source return below synchronously unsubscribes and resolves any
    // pending next(), so neither cleanup path waits for another pubsub event.
    releaseCapacity();
    closePromise = source.return().then(completedResult);
    return closePromise;
  };

  const iterator: CancellableAsyncIterator<ClimbStatsSubscriptionPayload> = {
    async next(): Promise<IteratorResult<ClimbStatsSubscriptionPayload>> {
      if (closed) return completedResult();
      try {
        const result = await source.next();
        if (closed || result.done) {
          closed = true;
          releaseCapacity();
          return completedResult();
        }
        return { value: { climbStatsUpdated: result.value }, done: false };
      } catch (error) {
        closed = true;
        releaseCapacity();
        throw error;
      }
    },
    return: close,
    async throw(error?: unknown): Promise<IteratorResult<ClimbStatsSubscriptionPayload>> {
      await close();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return iterator;
}

export const climbStatsSubscriptions = {
  climbStatsUpdated: {
    subscribe: async (
      _: unknown,
      { boardType, layoutId }: { boardType: string; layoutId: number },
      ctx: ConnectionContext,
    ): Promise<CancellableAsyncIterator<ClimbStatsSubscriptionPayload>> => {
      requireAuthenticated(ctx);
      if (!VALID_BOARD_TYPES.has(boardType)) throw new Error(`Invalid board type: ${boardType}`);
      if (!Number.isInteger(layoutId) || layoutId < 1 || layoutId > MAX_LAYOUT_ID) {
        throw new Error(`Invalid layout id: ${layoutId}`);
      }

      // The channel key IS the caller's `boardType:layoutId`, and a spray wall's
      // layout id comes out of a sequence — so without this, any signed-in account
      // could walk the sequence and hold a live feed of a private wall's climb
      // uuids, ascent counts, quality and setter grade, updated on every tick. The
      // same gate the sibling subscriptions take (`newClimbCreated`,
      // `boardNowPlaying`); refused rather than silently empty, because a
      // subscription that yields nothing is indistinguishable from a quiet wall and
      // the client would hold the slot forever.
      await assertSprayBoardIsReadable({ boardType, layoutId }, ctx.userId);

      acquireClimbStatsSubscription(ctx.connectionId);
      let capacityReleased = false;
      const releaseCapacity = () => {
        if (capacityReleased) return;
        capacityReleased = true;
        releaseClimbStatsSubscription(ctx.connectionId);
      };
      try {
        const channelKey = `${boardType}:${layoutId}`;
        const source = await createAsyncIterator<ClimbStatsEvent>(
          (push) => pubsub.subscribeClimbStats(channelKey, push),
          `climbStatsUpdated:${channelKey}`,
        );
        return mapClimbStatsIterator(source, releaseCapacity);
      } catch (error) {
        releaseCapacity();
        throw error;
      }
    },
  },
};
