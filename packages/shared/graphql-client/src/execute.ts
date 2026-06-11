import type { Client } from 'graphql-ws';
import { GraphQLOperationError, parseRateLimitError, type RateLimitError } from './errors';
import { getOperationName } from './operation-name';
import { MUTATION_TIMEOUT_MS } from './constants';

const DEFAULT_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;
const RATE_LIMIT_RETRY_DELAY_CAP_MS = 30_000;
const RATE_LIMIT_RETRY_JITTER_MS = 250;

export type RateLimitRetryEvent = {
  error: RateLimitError;
  attempt: number;
  maxAttempts: number;
  retryAfterMs: number;
  operationName: string;
};

export type ExecuteOptions = {
  timeoutMs?: number;
  rateLimitRetries?: number;
  maxRateLimitDelayMs?: number;
  rateLimitJitterMs?: number;
  onRateLimited?: (event: RateLimitRetryEvent) => void;
  sleep?: (ms: number) => Promise<void>;
};

function normalizeExecuteOptions(timeoutOrOptions: number | ExecuteOptions | undefined): Required<ExecuteOptions> {
  if (typeof timeoutOrOptions === 'number') {
    return {
      timeoutMs: timeoutOrOptions,
      rateLimitRetries: DEFAULT_RATE_LIMIT_RETRIES,
      maxRateLimitDelayMs: RATE_LIMIT_RETRY_DELAY_CAP_MS,
      rateLimitJitterMs: RATE_LIMIT_RETRY_JITTER_MS,
      onRateLimited: () => {},
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  return {
    timeoutMs: timeoutOrOptions?.timeoutMs ?? MUTATION_TIMEOUT_MS,
    rateLimitRetries: timeoutOrOptions?.rateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES,
    maxRateLimitDelayMs: timeoutOrOptions?.maxRateLimitDelayMs ?? RATE_LIMIT_RETRY_DELAY_CAP_MS,
    rateLimitJitterMs: timeoutOrOptions?.rateLimitJitterMs ?? RATE_LIMIT_RETRY_JITTER_MS,
    onRateLimited: timeoutOrOptions?.onRateLimited ?? (() => {}),
    sleep: timeoutOrOptions?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function getRetryAfterMs(error: RateLimitError, options: Required<ExecuteOptions>): number {
  const retryAfterMs =
    error.retryAfterSeconds === null ? DEFAULT_RATE_LIMIT_DELAY_MS : Math.max(0, error.retryAfterSeconds * 1000);
  const cappedRetryAfterMs = Math.min(retryAfterMs, options.maxRateLimitDelayMs);
  const jitterMs = options.rateLimitJitterMs > 0 ? Math.round(Math.random() * options.rateLimitJitterMs) : 0;
  return cappedRetryAfterMs + jitterMs;
}

/**
 * Execute a GraphQL mutation (or one-shot query) over a graphql-ws client.
 *
 * graphql-ws models everything as subscriptions: a mutation emits one `next`
 * payload, then `complete`. We resolve with the captured payload on
 * `complete`, reject on `error`, and apply a wall-clock timeout to keep the
 * caller from hanging if the connection is wedged. Rate-limit failures retry
 * with a fresh timeout for each attempt so the wait itself cannot trip the
 * mutation timeout.
 */
export function execute<TData = unknown, TVariables = Record<string, unknown>>(
  client: Client,
  operation: { query: string; variables?: TVariables },
  timeoutOrOptions: number | ExecuteOptions = MUTATION_TIMEOUT_MS,
): Promise<TData> {
  const opName = getOperationName(operation, 'mutation');
  const options = normalizeExecuteOptions(timeoutOrOptions);

  async function executeWithRetries(): Promise<TData> {
    let retriesUsed = 0;

    while (true) {
      try {
        return await executeOnce(options.timeoutMs);
      } catch (error) {
        const rateLimitError = parseRateLimitError(error);
        if (!rateLimitError) {
          throw error;
        }
        if (retriesUsed >= options.rateLimitRetries) {
          throw rateLimitError;
        }

        retriesUsed += 1;
        const retryAfterMs = getRetryAfterMs(rateLimitError, options);
        options.onRateLimited({
          error: rateLimitError,
          attempt: retriesUsed,
          maxAttempts: options.rateLimitRetries,
          retryAfterMs,
          operationName: opName,
        });
        await options.sleep(retryAfterMs);
      }
    }
  }

  function executeOnce(timeoutMs: number): Promise<TData> {
    return new Promise<TData>((resolve, reject) => {
      let result: TData | undefined;
      let hasResolved = false;
      let unsubscribe: (() => void) | undefined;

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`GraphQL mutation '${opName}' timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      function settle(fn: () => void) {
        if (hasResolved) return;
        hasResolved = true;
        clearTimeout(timer);
        unsubscribe?.();
        fn();
      }

      unsubscribe = client.subscribe<TData>(
        { query: operation.query, variables: operation.variables as Record<string, unknown> },
        {
          next: (data) => {
            if ('data' in data) {
              result = data.data as TData;
            }
            if (data.errors) {
              const errors = data.errors;
              settle(() => reject(new GraphQLOperationError(errors)));
            }
          },
          error: (err) => {
            settle(() => {
              // graphql-ws also reports server-emitted GraphQL errors through the
              // error callback when the server closes the stream with them (e.g.
              // single-error mutation rejects). Preserve extensions in that path
              // too, otherwise fall back to a generic Error.
              if (Array.isArray(err) && err.length > 0 && typeof err[0]?.message === 'string') {
                reject(new GraphQLOperationError(err));
              } else if (err instanceof Error) {
                reject(err);
              } else {
                reject(new Error(String(err)));
              }
            });
          },
          complete: () => {
            settle(() => {
              if (result === undefined) {
                reject(new Error(`GraphQL operation '${opName}' completed without data`));
                return;
              }
              resolve(result);
            });
          },
        },
      );
    });
  }

  return executeWithRetries();
}
