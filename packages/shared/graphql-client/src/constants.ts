/** Initial delay before the first retry (milliseconds). */
export const INITIAL_RETRY_DELAY_MS = 1000;

/** Maximum delay between retries (milliseconds). */
export const MAX_RETRY_DELAY_MS = 30_000;

/** Multiplier applied to the delay after each successive retry. */
export const BACKOFF_MULTIPLIER = 2;

/** Maximum number of transient-join retries before treating as definitive failure. */
export const MAX_TRANSIENT_RETRIES = 5;

/** graphql-ws keepalive ping interval. */
export const KEEP_ALIVE_MS = 5000;

/** Default timeout applied to a single `execute()` call. */
export const MUTATION_TIMEOUT_MS = 30_000;
