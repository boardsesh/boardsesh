import { describe, it, expect } from 'vitest';
import { PLAYLIST_DRAIN_MAX_TOTAL_WAIT_MS } from '@boardsesh/playlists-react';
import {
  createPlaylistPageRetryPolicy,
  MAX_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_FALLBACK_WAIT_MS,
  RATE_LIMIT_JITTER_MS,
} from '../playlist-page-retry';

/**
 * graphql-request's `ClientError` shape — the drain runs over HTTP, so this is
 * the literal object `parseRateLimitError` has to walk in production.
 */
function makeClientError(message: string, extensions: Record<string, unknown>): Error {
  const clientError = new Error(message) as Error & { response: unknown };
  clientError.name = 'ClientError';
  clientError.response = { errors: [{ message, extensions }] };
  return clientError;
}

function makeRateLimited(retryAfterSeconds?: number): Error {
  return makeClientError('Rate limit exceeded', {
    code: 'RATE_LIMITED',
    operation: 'smartPlaylist',
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

function makeAbortError(): Error {
  const abortError = new Error('Aborted');
  abortError.name = 'AbortError';
  return abortError;
}

describe('createPlaylistPageRetryPolicy', () => {
  it('honours retryAfterSeconds on a RATE_LIMITED page, then gives up', () => {
    const policy = createPlaylistPageRetryPolicy();
    const rateLimited = makeRateLimited(46);

    const firstWaitMs = policy(rateLimited, 0);
    expect(firstWaitMs).toBeGreaterThanOrEqual(46_000);
    expect(firstWaitMs).toBeLessThanOrEqual(46_000 + RATE_LIMIT_JITTER_MS);
    // One honest wait clears the whole fixed window; a second would just stall.
    expect(policy(rateLimited, 1)).toBeNull();
  });

  it('falls back to a short wait when the server sent no retryAfterSeconds', () => {
    const waitMs = createPlaylistPageRetryPolicy()(makeRateLimited(), 0);

    expect(waitMs).toBeGreaterThanOrEqual(RATE_LIMIT_FALLBACK_WAIT_MS);
    expect(waitMs).toBeLessThanOrEqual(RATE_LIMIT_FALLBACK_WAIT_MS + RATE_LIMIT_JITTER_MS);
  });

  it('retries a transport drop twice with a short backoff', () => {
    const policy = createPlaylistPageRetryPolicy();
    const droppedPage = new TypeError('Network request failed');

    expect(policy(droppedPage, 0)).toBe(400);
    expect(policy(droppedPage, 1)).toBe(1_200);
    expect(policy(droppedPage, 2)).toBeNull();
  });

  it('never retries an abort', () => {
    // A cancelled activation must stop, not back off. Guards against
    // `isTransportNetworkError`'s deliberate AbortError exclusion drifting.
    expect(createPlaylistPageRetryPolicy()(makeAbortError(), 0)).toBeNull();
  });

  it('never retries a plain GraphQL validation rejection', () => {
    // A real bug must fail fast instead of burning the climber's page budget.
    const badInput = makeClientError('Invalid playlist input', { code: 'BAD_USER_INPUT' });

    expect(createPlaylistPageRetryPolicy()(badInput, 0)).toBeNull();
  });

  // The two classes fail for unrelated reasons. A single shared counter let one
  // wifi blip spend the page's only rate-limit retry, so the throttle that
  // followed gave up immediately and truncated the playlist.
  it('keeps a separate budget per error class', () => {
    const policy = createPlaylistPageRetryPolicy();

    // A transport drop first. The `attempt` the drain passes keeps climbing,
    // which is exactly what a shared counter would key its budget off.
    expect(policy(new TypeError('Network request failed'), 0)).toBe(400);

    // The re-send reaches the server and gets throttled. The rate-limit retry
    // must still be available.
    const rateLimitWaitMs = policy(makeRateLimited(46), 1);
    expect(rateLimitWaitMs).toBeGreaterThanOrEqual(46_000);

    // ...and the network budget is still where the drop left it, so the next
    // drop gets the second network step rather than starting over or ending.
    expect(policy(new TypeError('Network request failed'), 2)).toBe(1_200);
    expect(policy(new TypeError('Network request failed'), 3)).toBeNull();
    // The one rate-limit retry is genuinely spent, though.
    expect(policy(makeRateLimited(46), 4)).toBeNull();
  });

  // A wait longer than the drain's budget is refused outright instead of being
  // slept, so a wait that overshoots the cap silently costs the page its retry.
  it('caps a rate-limit wait — jitter included — within the drain wait budget', () => {
    expect(MAX_RATE_LIMIT_WAIT_MS).toBeLessThanOrEqual(PLAYLIST_DRAIN_MAX_TOTAL_WAIT_MS);

    // The server emits a full-window hint whenever a throttled request lands in
    // the first second of its aligned bucket, so this is routine traffic.
    const fullWindowHint = createPlaylistPageRetryPolicy()(makeRateLimited(60), 0);
    expect(fullWindowHint).toBeLessThanOrEqual(MAX_RATE_LIMIT_WAIT_MS);
    expect(fullWindowHint).toBeGreaterThan(MAX_RATE_LIMIT_WAIT_MS - RATE_LIMIT_JITTER_MS - 1);

    const absurdHint = createPlaylistPageRetryPolicy()(makeRateLimited(900), 0);
    expect(absurdHint).toBeLessThanOrEqual(MAX_RATE_LIMIT_WAIT_MS);
  });
});
