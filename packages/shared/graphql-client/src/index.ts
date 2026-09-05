// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export type { Client, Sink } from 'graphql-ws';

export {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  BACKOFF_MULTIPLIER,
  MAX_TRANSIENT_RETRIES,
  KEEP_ALIVE_MS,
  MUTATION_TIMEOUT_MS,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_FALLBACK_DELAY_MS,
  RATE_LIMIT_MAX_WAIT_MS,
  RATE_LIMIT_RETRY_JITTER_MS,
  RECONNECT_JITTER_RATIO,
} from './constants';

export type { GraphQLErrorExtensions, ParsedRateLimit } from './errors';
export {
  GraphQLOperationError,
  isClimbDuplicateExtension,
  isRateLimitedExtension,
  isNotSessionMemberExtension,
  isNotSessionMemberError,
  parseRateLimitError,
  isRateLimitedError,
} from './errors';

export { getOperationName } from './operation-name';

export type { ExecuteOptions, RateLimitRetryEvent } from './execute';
export { execute } from './execute';
export { subscribe } from './subscribe';

export type { BaseClientOptions, CreateGraphQLClientOptions, ExtendedClient } from './create-client';
export { createGraphQLClient } from './create-client';
