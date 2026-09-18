import { type ConnectionContext, type NewClimbCreatedEvent, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator } from '../shared/async-iterators';
import { withSubscriptionCleanup } from '../shared/managed-subscription';
import { isSprayBoardType, sprayLayoutIsReadable, sprayStreamGate } from '../climbs/spray-read-access';

export const newClimbFeedSubscription = {
  newClimbCreated: {
    subscribe: withSubscriptionCleanup(async function* (
      lifetime,
      _: unknown,
      { boardType, layoutId }: { boardType: string; layoutId: number },
      ctx: ConnectionContext,
    ) {
      if (!SUPPORTED_BOARDS.includes(boardType as (typeof SUPPORTED_BOARDS)[number])) {
        throw new Error(`Invalid boardType: ${boardType}`);
      }
      if (!Number.isInteger(layoutId) || layoutId <= 0) {
        throw new Error('layoutId must be a positive integer');
      }

      // The channel key is just `boardType:layoutId`, so without this a stranger
      // could subscribe to live pushes of every climb set on a private spray wall.
      // Ending the stream immediately is the "empty page" of a subscription: the
      // caller sees a normal, empty subscription rather than an error that would
      // confirm the wall exists.
      //
      // Belt and braces with the publisher, which only announces for public walls —
      // but the publisher's rule lives in `saveClimb` and a future producer on this
      // channel would not inherit it.
      if (isSprayBoardType(boardType) && !(await sprayLayoutIsReadable(boardType, layoutId, ctx.userId))) {
        return;
      }

      const channelKey = `${boardType}:${layoutId}`;

      const asyncIterator = await lifetime.own(
        createAsyncIterator<NewClimbCreatedEvent>((push) => {
          return pubsub.subscribeNewClimbs(channelKey, push);
        }, `newClimbCreated:${channelKey}`),
      );

      // The gate above ran once, at subscribe. A socket outlives that answer: the
      // owner can take the wall private, or a gym can revoke the membership the
      // answer rested on, and the client that was already watching would keep
      // receiving every climb set on the wall. Re-asked per EVENT, which is the only
      // moment it matters and is free on the other eight board types (null gate).
      const gate = sprayStreamGate(boardType, layoutId, ctx.userId);
      for await (const event of asyncIterator) {
        if (gate && !(await gate())) return;
        yield { newClimbCreated: event };
      }
    }),
  },
};
