// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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

/**
 * How many times `execute()` re-sends a mutation the backend rejected with
 * `RATE_LIMITED`. Safe to retry because the rate-limit gate throws BEFORE the
 * resolver does any work (see `applyRateLimit` in the backend), so a throttled
 * attempt has no side effect. Bounded so a persistently-throttled op still
 * fails rather than hammering the server forever.
 */
export const RATE_LIMIT_MAX_RETRIES = 2;

/** Wait before the first rate-limit retry when the server sent no `retryAfterSeconds` (ms). */
export const RATE_LIMIT_FALLBACK_DELAY_MS = 1000;

/** Upper bound on a single rate-limit retry wait, even if the server asks for longer (ms). */
export const RATE_LIMIT_MAX_WAIT_MS = 30_000;

/** Random jitter added to each rate-limit retry wait so a burst of clients de-syncs (ms). */
export const RATE_LIMIT_RETRY_JITTER_MS = 250;

/**
 * Fraction of the transport reconnect backoff turned into random jitter, so a
 * fleet of clients that all dropped at once (backend restart) doesn't reconnect
 * in lockstep and re-trip the rate limiter in synchronized waves. A value of
 * 0.5 spreads each attempt over [0.5·delay, delay].
 */
export const RECONNECT_JITTER_RATIO = 0.5;
