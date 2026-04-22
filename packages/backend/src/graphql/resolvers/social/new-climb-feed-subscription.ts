import type { NewClimbCreatedEvent } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator } from '../shared/async-iterators';

export const newClimbFeedSubscription = {
  newClimbCreated: {
    subscribe: async function* (_: unknown, { boardType, layoutId }: { boardType: string; layoutId: number }) {
      if (!SUPPORTED_BOARDS.includes(boardType as (typeof SUPPORTED_BOARDS)[number])) {
        throw new Error(`Invalid boardType: ${boardType}`);
      }
      if (!Number.isInteger(layoutId) || layoutId <= 0) {
        throw new Error('layoutId must be a positive integer');
      }

      const channelKey = `${boardType}:${layoutId}`;

      const asyncIterator = await createAsyncIterator<NewClimbCreatedEvent>((push) => {
        return pubsub.subscribeNewClimbs(channelKey, push);
      });

      for await (const event of asyncIterator) {
        yield { newClimbCreated: event };
      }
    },
  },
};
