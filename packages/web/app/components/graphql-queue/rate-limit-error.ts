import type { GraphQLFormattedError } from 'graphql';

export const RATE_LIMIT_ERROR_CODE = 'RATE_LIMITED';

export const MAX_RATE_LIMIT_RETRIES = 2;
export const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export class RateLimitError extends Error {
  readonly name = 'RateLimitError';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message?: string) {
    super(message ?? `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Modern backends attach { code: 'RATE_LIMITED', retryAfterSeconds } in extensions.
// Older deployments only return the human-readable message — fall back to regex.
const MESSAGE_PATTERN = /Try again in (\d+)\s*seconds?/i;

export function parseRateLimitError(errors: readonly GraphQLFormattedError[] | undefined): RateLimitError | null {
  if (!errors?.length) return null;

  for (const err of errors) {
    const code = err.extensions?.code;
    if (code === RATE_LIMIT_ERROR_CODE) {
      const retryAfter = err.extensions?.retryAfterSeconds;
      const seconds = typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS;
      return new RateLimitError(seconds, err.message);
    }
  }

  for (const err of errors) {
    if (!err.message?.startsWith('Rate limit exceeded')) continue;
    const match = err.message.match(MESSAGE_PATTERN);
    const seconds = match ? Number(match[1]) : DEFAULT_RETRY_AFTER_SECONDS;
    return new RateLimitError(seconds, err.message);
  }

  return null;
}

// Module-level pub/sub so the QueueContext can surface a toast on retry without
// threading a callback through 4 layers (QueueContext → persistent-session →
// useQueueMutations → execute). execute() emits, listeners subscribe.
type RateLimitListener = (err: RateLimitError, attempt: number) => void;
const listeners = new Set<RateLimitListener>();

export function onRateLimited(listener: RateLimitListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitRateLimited(err: RateLimitError, attempt: number): void {
  for (const listener of listeners) {
    try {
      listener(err, attempt);
    } catch {
      // Listener failures must not interfere with retry logic.
    }
  }
}
