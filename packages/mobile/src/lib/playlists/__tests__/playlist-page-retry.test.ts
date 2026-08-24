import { describe, it, expect } from 'vitest';
import {
  shouldRetryPlaylistPage,
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

function makeAbortError(): Error {
  const abortError = new Error('Aborted');
  abortError.name = 'AbortError';
  return abortError;
}

describe('shouldRetryPlaylistPage', () => {
  it('honours retryAfterSeconds on a RATE_LIMITED page, then gives up', () => {
    const rateLimited = makeClientError('Rate limit exceeded. Try again in 46 seconds.', {
      code: 'RATE_LIMITED',
      operation: 'smartPlaylist',
      retryAfterSeconds: 46,
    });

    const firstWaitMs = shouldRetryPlaylistPage(rateLimited, 0);
    expect(firstWaitMs).toBeGreaterThanOrEqual(46_000);
    expect(firstWaitMs).toBeLessThanOrEqual(46_000 + RATE_LIMIT_JITTER_MS);
    // One honest wait clears the whole fixed window; a second would just stall.
    expect(shouldRetryPlaylistPage(rateLimited, 1)).toBeNull();
  });

  it('caps a rate-limit wait at the server window', () => {
    const absurdHint = makeClientError('Rate limit exceeded. Try again in 900 seconds.', {
      code: 'RATE_LIMITED',
      retryAfterSeconds: 900,
    });

    const waitMs = shouldRetryPlaylistPage(absurdHint, 0);
    expect(waitMs).toBeGreaterThanOrEqual(MAX_RATE_LIMIT_WAIT_MS);
    expect(waitMs).toBeLessThanOrEqual(MAX_RATE_LIMIT_WAIT_MS + RATE_LIMIT_JITTER_MS);
  });

  it('falls back to a short wait when the server sent no retryAfterSeconds', () => {
    const hintless = makeClientError('Rate limit exceeded', { code: 'RATE_LIMITED' });

    const waitMs = shouldRetryPlaylistPage(hintless, 0);
    expect(waitMs).toBeGreaterThanOrEqual(RATE_LIMIT_FALLBACK_WAIT_MS);
    expect(waitMs).toBeLessThanOrEqual(RATE_LIMIT_FALLBACK_WAIT_MS + RATE_LIMIT_JITTER_MS);
  });

  it('retries a transport drop twice with a short backoff', () => {
    const droppedPage = new TypeError('Network request failed');

    expect(shouldRetryPlaylistPage(droppedPage, 0)).toBe(400);
    expect(shouldRetryPlaylistPage(droppedPage, 1)).toBe(1_200);
    expect(shouldRetryPlaylistPage(droppedPage, 2)).toBeNull();
  });

  it('never retries an abort', () => {
    // A cancelled activation must stop, not back off. Guards against
    // `isTransportNetworkError`'s deliberate AbortError exclusion drifting.
    expect(shouldRetryPlaylistPage(makeAbortError(), 0)).toBeNull();
  });

  it('never retries a plain GraphQL validation rejection', () => {
    // A real bug must fail fast instead of burning the climber's page budget.
    const badInput = makeClientError('Invalid playlist input', { code: 'BAD_USER_INPUT' });

    expect(shouldRetryPlaylistPage(badInput, 0)).toBeNull();
  });
});
