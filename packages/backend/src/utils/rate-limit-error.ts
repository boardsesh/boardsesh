import { GraphQLError } from 'graphql';

export const RATE_LIMIT_ERROR_CODE = 'RATE_LIMITED';

export function createRateLimitError(retryAfterSeconds: number): GraphQLError {
  return new GraphQLError(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`, {
    extensions: {
      code: RATE_LIMIT_ERROR_CODE,
      retryAfterSeconds,
    },
  });
}
