import { SUPPORTED_BOARDS, type ClimbStatsEvent, type ConnectionContext } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator } from '../shared/async-iterators';

const VALID_BOARD_TYPES = new Set<string>(SUPPORTED_BOARDS);

// UUIDs from Aurora are typically 16 hex chars; our boardsesh-created climbs
// use 36-char UUIDs. 128 leaves plenty of headroom while bounding channel keys.
const MAX_CLIMB_UUID_LENGTH = 128;

// Boards expose angles in 5° increments between 0 and 90.
const ANGLE_MIN = 0;
const ANGLE_MAX = 90;

export const climbStatsSubscriptions = {
  climbStatsUpdated: {
    subscribe: async function* (
      _: unknown,
      { boardType, climbUuid, angle }: { boardType: string; climbUuid: string; angle: number },
      _ctx: ConnectionContext,
    ) {
      if (!VALID_BOARD_TYPES.has(boardType)) {
        throw new Error(`Invalid board type: ${boardType}`);
      }
      if (!climbUuid || climbUuid.length > MAX_CLIMB_UUID_LENGTH) {
        throw new Error('Invalid climb UUID');
      }
      if (!Number.isInteger(angle) || angle < ANGLE_MIN || angle > ANGLE_MAX) {
        throw new Error(`Invalid angle: ${angle}`);
      }

      const channelKey = `${boardType}:${climbUuid}:${angle}`;

      const asyncIterator = await createAsyncIterator<ClimbStatsEvent>((push) =>
        pubsub.subscribeClimbStats(channelKey, push),
      );

      for await (const event of asyncIterator) {
        yield { climbStatsUpdated: event };
      }
    },
  },
};
