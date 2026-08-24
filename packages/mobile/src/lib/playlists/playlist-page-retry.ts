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

/** Spread a fleet of clients that all got the same hint off the same instant. */
export const RATE_LIMIT_JITTER_MS = 250;

/**
 * Ceiling on a single rate-limit wait, JITTER INCLUDED. Must stay within the
 * drain's total wait budget or the wait is refused before it is ever slept and
 * the page loses its retry — the server emits a full-window hint whenever a
 * throttled request lands in the first second of its aligned bucket, so that is
 * a routine case, not a corner one. `RATE_LIMIT_WINDOW_MS` is 60s, so 60s minus
 * the jitter head-room is still past every legitimate hint. Deliberately NOT
 * the shared client's 30s `RATE_LIMIT_MAX_WAIT_MS`: waking early on the 46s
 * hints seen in production would spend the one retry on a still-throttled
 * bucket. `playlist-page-retry.test.ts` pins this at or under
 * `PLAYLIST_DRAIN_MAX_TOTAL_WAIT_MS` so the two can't drift apart.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** The largest wait the policy may ask for before jitter is added on top. */
const MAX_RATE_LIMIT_WAIT_BEFORE_JITTER_MS = MAX_RATE_LIMIT_WAIT_MS - RATE_LIMIT_JITTER_MS;

/** Used when a pre-#2763 server sends a rate limit with no `retryAfterSeconds`. */
export const RATE_LIMIT_FALLBACK_WAIT_MS = 2_000;

/** Two quick re-sends cover a gym-wifi to LTE handoff dropping one page. */
export const MAX_NETWORK_RETRIES_PER_PAGE = 2;
export const NETWORK_RETRY_WAIT_MS = [400, 1_200];

/**
 * Builds the retry policy for ONE page: how long to wait before re-sending it,
 * or `null` to give up on it.
 *
 * Each class of failure gets its OWN budget, which is why this is a factory
 * over a closure rather than a pure function of an attempt count. The two
 * classes fail for unrelated reasons and a shared counter lets one spend the
 * other's retries: a wifi-to-LTE handoff dropping page 7 would otherwise
 * consume the single rate-limit retry, so the throttle that follows gives up
 * immediately and the climber gets a truncated playlist that one honest wait
 * would have finished.
 */
export function createPlaylistPageRetryPolicy(): ShouldRetryPage {
  let rateLimitAttempts = 0;
  let networkAttempts = 0;

  return (error) => {
    const rateLimit = parseRateLimitError(error);
    if (rateLimit) {
      if (rateLimitAttempts >= MAX_RATE_LIMIT_RETRIES_PER_PAGE) return null;
      rateLimitAttempts += 1;
      const hintedWaitMs = (rateLimit.retryAfterSeconds ?? 0) * 1_000;
      const waitMs = Math.min(
        hintedWaitMs > 0 ? hintedWaitMs : RATE_LIMIT_FALLBACK_WAIT_MS,
        MAX_RATE_LIMIT_WAIT_BEFORE_JITTER_MS,
      );
      // Jitter goes INSIDE the ceiling, not on top of it: a wait over the
      // drain's budget is refused outright rather than slept, so overshooting
      // the cap by a jitter would silently cost the page its retry.
      return waitMs + Math.round(Math.random() * RATE_LIMIT_JITTER_MS);
    }
    // `isTransportNetworkError` excludes AbortError by design, so a cancelled
    // activation is never mistaken for a flaky connection.
    if (isTransportNetworkError(error)) {
      if (networkAttempts >= MAX_NETWORK_RETRIES_PER_PAGE) return null;
      const lastWaitMs = NETWORK_RETRY_WAIT_MS[NETWORK_RETRY_WAIT_MS.length - 1] ?? 0;
      const waitMs = NETWORK_RETRY_WAIT_MS[networkAttempts] ?? lastWaitMs;
      networkAttempts += 1;
      return waitMs;
    }
    return null;
  };
}
