import { GraphQLError } from 'graphql';

export const RATE_LIMITED_CODE = 'RATE_LIMITED';

export function createRateLimitGraphQLError(retryAfterSeconds: number): GraphQLError {
  return new GraphQLError(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`, {
    extensions: {
      code: RATE_LIMITED_CODE,
      retryAfterSeconds,
    },
  });
}

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof GraphQLError && error.extensions?.code === RATE_LIMITED_CODE) {
    return true;
  }
  return error instanceof Error && error.message.startsWith('Rate limit exceeded');
}
