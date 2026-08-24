// Retry policy for one page of a playlist drain (#4622).
//
// Lives on the mobile side rather than in @boardsesh/playlists-react because
// this is where the transport error shapes are known: the shared drain injects
// the policy so it needs no GraphQL client and no error-classification
// dependency of its own.
//
// Deliberately narrow. Only two classes of rejection are worth re-sending:
//
//   - RATE_LIMITED, where the server is explicitly handing back a
//     `retryAfterSeconds` and the resolver threw BEFORE doing any work
//     (`applyRateLimit` is the first statement of the smartPlaylist resolver),
//     so a re-send cannot double anything.
//   - A transport drop, which never reached the server at all.
//
// Everything else — GraphQL validation errors, 4xx, programmer bugs — fails the
// page immediately. Retrying those only burns the climber's per-minute budget
// and delays the real failure.
//
// This is scoped to the drain on purpose. The app-wide policy is the opposite
// (`query-provider.tsx`: never retry a RATE_LIMITED rejection), because retry is
// only correct for requests the client itself is fanning out and can pace.

import { parseRateLimitError } from '@boardsesh/graphql-client';
import { isTransportNetworkError } from '@boardsesh/offline-sync/error-classification';
import type { ShouldRetryPage } from '@boardsesh/playlists-react';

/**
 * One rate-limit retry per page. The backend window is a FIXED aligned 60s
 * bucket, so its `retryAfterSeconds` hint always lands past the reset and one
 * honest wait clears the whole budget. A second would only help if something
 * else spent the budget while we slept.
 */
export const MAX_RATE_LIMIT_RETRIES_PER_PAGE = 1;

/**
 * Ceiling on a single rate-limit wait. `RATE_LIMIT_WINDOW_MS` is 60s, so a
 * legitimate hint can never exceed it. Deliberately NOT the shared client's 30s
 * `RATE_LIMIT_MAX_WAIT_MS`: waking early on the 46s hints seen in production
 * would spend the one retry on a still-throttled bucket.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** Used when a pre-#2763 server sends a rate limit with no `retryAfterSeconds`. */
export const RATE_LIMIT_FALLBACK_WAIT_MS = 2_000;

/** Spread a fleet of clients that all got the same hint off the same instant. */
export const RATE_LIMIT_JITTER_MS = 250;

/** Two quick re-sends cover a gym-wifi to LTE handoff dropping one page. */
export const MAX_NETWORK_RETRIES_PER_PAGE = 2;
export const NETWORK_RETRY_WAIT_MS = [400, 1_200];

/**
 * How long to wait before re-sending a failed playlist page, or `null` to give
 * up on it. `attempt` is 0 on the first failure.
 */
export const shouldRetryPlaylistPage: ShouldRetryPage = (error, attempt) => {
  const rateLimit = parseRateLimitError(error);
  if (rateLimit) {
    if (attempt >= MAX_RATE_LIMIT_RETRIES_PER_PAGE) return null;
    const hintedWaitMs = (rateLimit.retryAfterSeconds ?? 0) * 1_000;
    const waitMs = Math.min(hintedWaitMs > 0 ? hintedWaitMs : RATE_LIMIT_FALLBACK_WAIT_MS, MAX_RATE_LIMIT_WAIT_MS);
    return waitMs + Math.round(Math.random() * RATE_LIMIT_JITTER_MS);
  }
  // `isTransportNetworkError` excludes AbortError by design, so a cancelled
  // activation is never mistaken for a flaky connection.
  if (isTransportNetworkError(error)) {
    if (attempt >= MAX_NETWORK_RETRIES_PER_PAGE) return null;
    const lastWaitMs = NETWORK_RETRY_WAIT_MS[NETWORK_RETRY_WAIT_MS.length - 1] ?? 0;
    return NETWORK_RETRY_WAIT_MS[attempt] ?? lastWaitMs;
  }
  return null;
};
