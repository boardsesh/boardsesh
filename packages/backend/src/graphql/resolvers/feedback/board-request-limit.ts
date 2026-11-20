import { isLocalDevelopment, isTestEnvironment } from '@boardsesh/db/client/config';
import { GraphQLError } from 'graphql';
import { redisClientManager } from '../../../redis/client';
import { RateLimitError } from '../../../utils/rate-limiter';
import { consumeRateLimitRedis } from '../../../utils/redis-rate-limiter';

export async function chargeBoardRequestAddress(trustedClientIp: string | undefined): Promise<void> {
  if (trustedClientIp && trustedClientIp !== 'unknown') {
    try {
      await consumeRateLimitRedis(`board-request-ip:${trustedClientIp}`, 'submitBoardRequest', 5, 60_000, {
        requireDistributed: (!isLocalDevelopment() && !isTestEnvironment()) || redisClientManager.isRedisConfigured(),
      });
      return;
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw new GraphQLError('Too many board requests.', {
          extensions: { code: 'RATE_LIMITED', retryAfterSeconds: error.retryAfterSeconds },
        });
      }
    }
  }
  throw new GraphQLError('Board requests are temporarily unavailable.', {
    extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 60 },
  });
}
