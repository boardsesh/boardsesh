import type { Client } from 'graphql-ws';
import { GraphQLOperationError, GraphQLTransportClosedError, isLikeCloseEvent, parseRateLimitError } from './errors';
import { getOperationName } from './operation-name';
import {
  MUTATION_TIMEOUT_MS,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_FALLBACK_DELAY_MS,
  RATE_LIMIT_MAX_WAIT_MS,
  RATE_LIMIT_RETRY_JITTER_MS,
} from './constants';

/**
 * The client `execute` sends on: either a client, or a getter it calls again
 * for every attempt. Pass a getter when the client can be replaced while an
 * attempt waits out a rate limit. A disposed graphql-ws client still opens a
 * fresh socket for each new operation, and no later dispose owns that socket.
 */
export type ClientSource = Client | (() => Client);

/** Payload handed to `onRateLimited` before each rate-limit retry wait. */
export type RateLimitRetryEvent = {
  /** 1-based retry number (1 = first retry after the initial rejection). */
  attempt: number;
  /** Total retries `execute` will make before giving up. */
  maxAttempts: number;
  /** How long this attempt waits before re-sending (ms, jitter included). */
  retryAfterMs: number;
  /** Operation name parsed from the query (for logging / UX copy). */
  operationName: string;
};

export type ExecuteOptions = {
  /** Per-attempt wall-clock timeout (ms). Reset on every retry. */
  timeoutMs?: number;
  /** Retries on `RATE_LIMITED` before giving up. Set 0 to disable. */
  rateLimitRetries?: number;
  /** Ceiling on a single retry wait, ignoring a larger server hint (ms). */
  maxRateLimitDelayMs?: number;
  /** Random jitter added to each retry wait (ms). */
  rateLimitJitterMs?: number;
  /** Notified before each retry wait — web wires a "catching up" snackbar here. */
  onRateLimited?: (event: RateLimitRetryEvent) => void;
  /** Injectable sleep (tests pass an immediate/controlled resolver). */
  sleep?: (ms: number) => Promise<void>;
};

function normalizeExecuteOptions(timeoutOrOptions: number | ExecuteOptions | undefined): Required<ExecuteOptions> {
  const options = typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : (timeoutOrOptions ?? {});
  return {
    timeoutMs: options.timeoutMs ?? MUTATION_TIMEOUT_MS,
    rateLimitRetries: options.rateLimitRetries ?? RATE_LIMIT_MAX_RETRIES,
    maxRateLimitDelayMs: options.maxRateLimitDelayMs ?? RATE_LIMIT_MAX_WAIT_MS,
    rateLimitJitterMs: options.rateLimitJitterMs ?? RATE_LIMIT_RETRY_JITTER_MS,
    onRateLimited: options.onRateLimited ?? (() => {}),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function computeRateLimitWait(retryAfterSeconds: number | null, options: Required<ExecuteOptions>): number {
  const requested = retryAfterSeconds === null ? RATE_LIMIT_FALLBACK_DELAY_MS : Math.max(0, retryAfterSeconds * 1000);
  const capped = Math.min(requested, options.maxRateLimitDelayMs);
  const jitter = options.rateLimitJitterMs > 0 ? Math.round(Math.random() * options.rateLimitJitterMs) : 0;
  return capped + jitter;
}

/**
 * Execute a GraphQL mutation (or one-shot query) over a graphql-ws client.
 *
 * graphql-ws models everything as subscriptions: a mutation emits one `next`
 * payload, then `complete`. We resolve with the captured payload on
 * `complete`, reject on `error`, and apply a wall-clock timeout to keep the
 * caller from hanging if the connection is wedged.
 *
 * A `RATE_LIMITED` rejection is retried (bounded) after waiting the server's
 * `retryAfterSeconds` (capped, plus jitter). Each attempt gets a FRESH timeout
 * so the back-off wait can't itself trip the mutation timeout. This is the
 * quiet path for reconnect bursts (e.g. offline-reconciliation replaying
 * buffered adds) — the throttled request did no work, so re-sending is safe.
 *
 * `client` may be a getter. It is read again for every attempt, including each
 * attempt after a rate-limit wait, so a retry goes out on the client that is
 * current then, not on one that was disposed during the wait.
 *
 * Back-compat: the third arg may be a plain `timeoutMs` number (legacy callers)
 * or an `ExecuteOptions` object.
 */
export function execute<TData = unknown, TVariables = Record<string, unknown>>(
  client: ClientSource,
  operation: { query: string; variables?: TVariables },
  timeoutOrOptions: number | ExecuteOptions = MUTATION_TIMEOUT_MS,
): Promise<TData> {
  const opName = getOperationName(operation, 'mutation');
  const options = normalizeExecuteOptions(timeoutOrOptions);

  function executeOnce(): Promise<TData> {
    return new Promise<TData>((resolve, reject) => {
      let result: TData | undefined;
      let hasResolved = false;
      let unsubscribe: (() => void) | undefined;

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`GraphQL mutation '${opName}' timed out after ${options.timeoutMs}ms`)));
      }, options.timeoutMs);

      function settle(fn: () => void) {
        if (hasResolved) return;
        hasResolved = true;
        clearTimeout(timer);
        unsubscribe?.();
        fn();
      }

      const attemptClient = typeof client === 'function' ? client() : client;
      unsubscribe = attemptClient.subscribe<TData>(
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
              } else if (isLikeCloseEvent(err)) {
                // graphql-ws gave up on the socket and handed over its close
                // event. Keep the code so a caller can tell a lost transport
                // from a server answer. Checked before `instanceof Error`:
                // graphql-ws's own TerminatedCloseEvent is an Error subclass.
                reject(new GraphQLTransportClosedError(err.code, err.reason));
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

  async function executeWithRetries(): Promise<TData> {
    let retriesUsed = 0;
    for (;;) {
      try {
        return await executeOnce();
      } catch (error) {
        const rateLimit = parseRateLimitError(error);
        if (!rateLimit || retriesUsed >= options.rateLimitRetries) {
          // Not throttled, or out of retries — surface the original error so
          // callers keep the classifiable `GraphQLOperationError` extensions.
          throw error;
        }
        retriesUsed += 1;
        const retryAfterMs = computeRateLimitWait(rateLimit.retryAfterSeconds, options);
        options.onRateLimited({
          attempt: retriesUsed,
          maxAttempts: options.rateLimitRetries,
          retryAfterMs,
          operationName: opName,
        });
        await options.sleep(retryAfterMs);
      }
    }
  }

  return executeWithRetries();
}
