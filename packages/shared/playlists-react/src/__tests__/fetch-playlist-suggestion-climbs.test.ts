import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import {
  drainPlaylistPages,
  fetchPlaylistSuggestionClimbs,
  isAbortError,
  MAX_PLAYLIST_QUEUE_REPLACE_PAGES,
  PLAYLIST_PAGE_MAX_ATTEMPTS,
  PLAYLIST_RATE_LIMIT_MAX_WAIT_MS,
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
} from '../fetch-playlist-suggestion-climbs';

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'test',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a/V3',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
}

/** `pageSize` fresh climbs whose uuids are unique to `page`. */
function makePage(page: number, pageSize: number): Climb[] {
  return Array.from({ length: pageSize }, (_, index) => makeClimb(`p${page}-c${index}`));
}

/** A graphql-request `ClientError`-shaped rate limit, the shape the screens actually throw. */
function makeRateLimitError(retryAfterSeconds: number): Error {
  const error = new Error(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`);
  return Object.assign(error, {
    response: {
      errors: [
        {
          message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
          extensions: { code: 'RATE_LIMITED', operation: 'smartPlaylist', retryAfterSeconds },
        },
      ],
    },
  });
}

function makeTransportError(): TypeError {
  return new TypeError('Network request failed');
}

/** Records `(ms, signal)` and resolves immediately so the suite stays fast. */
function makeImmediateSleep() {
  return vi.fn(async (_ms: number, _signal: AbortSignal) => {});
}

const neverRetryable = () => false;
const noRateLimit = () => null;

afterEach(() => {
  vi.useRealTimers();
});

describe('drainPlaylistPages', () => {
  it('stops at maxPages when the server keeps claiming there is more', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
      climbs: makePage(page, 100),
      hasMore: true,
    }));

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: 100,
      maxPages: MAX_PLAYLIST_QUEUE_REPLACE_PAGES,
      isRetryable: neverRetryable,
      parseRetryAfterSeconds: noRateLimit,
      sleep: makeImmediateSleep(),
    });

    expect(fetchPage).toHaveBeenCalledTimes(MAX_PLAYLIST_QUEUE_REPLACE_PAGES);
    expect(result.stopReason).toBe('page-cap');
    expect(result.pagesFetched).toBe(MAX_PLAYLIST_QUEUE_REPLACE_PAGES);
    expect(result.climbs).toHaveLength(MAX_PLAYLIST_QUEUE_REPLACE_PAGES * 100);
  });

  // Replays the server defect fixed in 52d9a631f: past the recommendation offset
  // clamp the resolver re-served the SAME page with `hasMore: true` forever. The
  // client must not need a correct server to terminate.
  it('stops on no-progress when the server re-serves a page it already sent', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
      // Pages 0-4 are fresh; page 5 onward re-serves page 4, forever.
      climbs: makePage(Math.min(page, 4), 10),
      hasMore: true,
    }));

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: 10,
      maxPages: 50,
      isRetryable: neverRetryable,
      parseRetryAfterSeconds: noRateLimit,
      sleep: makeImmediateSleep(),
    });

    expect(result.stopReason).toBe('no-progress');
    expect(result.pagesFetched).toBe(6);
    expect(fetchPage).toHaveBeenCalledTimes(6);
    const uuids = result.climbs.map((climb) => climb.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(uuids).toHaveLength(50);
  });

  it('stops on no-progress for an empty page that still claims hasMore', async () => {
    const fetchPage = vi.fn(async () => ({ climbs: [], hasMore: true }));

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: 100,
      maxPages: 30,
      isRetryable: neverRetryable,
      parseRetryAfterSeconds: noRateLimit,
      sleep: makeImmediateSleep(),
    });

    expect(result.stopReason).toBe('no-progress');
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  // An empty playlist legitimately returns nothing and says so. That must stay
  // 'complete', because the mobile #3891 empty-fetch canary is gated on it.
  it('treats an empty final page as complete, not no-progress', async () => {
    const fetchPage = vi.fn(async () => ({ climbs: [], hasMore: false }));

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: 100,
      maxPages: 30,
      isRetryable: neverRetryable,
      parseRetryAfterSeconds: noRateLimit,
      sleep: makeImmediateSleep(),
    });

    expect(result.stopReason).toBe('complete');
    expect(result.climbs).toEqual([]);
  });

  it('retries a transport error once and completes', async () => {
    const sleep = makeImmediateSleep();
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<{ climbs: Climb[]; hasMore: boolean }>>()
      .mockResolvedValueOnce({ climbs: makePage(0, 2), hasMore: true })
      .mockRejectedValueOnce(makeTransportError())
      .mockResolvedValueOnce({ climbs: makePage(1, 2), hasMore: false });

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: 2,
      maxPages: 30,
      isRetryable: (error) => error instanceof TypeError,
      parseRetryAfterSeconds: noRateLimit,
      sleep,
      random: () => 0,
    });

    expect(result.stopReason).toBe('complete');
    expect(result.climbs).toHaveLength(4);
    // Page 1 was issued twice: 3 calls for 2 pages.
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[1]?.[0].page).toBe(1);
    expect(fetchPage.mock.calls[2]?.[0].page).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  // THE test. `smart-playlists.ts:350` throws a plain `Error('User not found')`
  // for a broken profile. Retrying that buys nothing and doubles the time to the
  // same toast, so a non-transport error must fail on the first attempt.
  it('does NOT retry a non-transport error', async () => {
    const sleep = makeImmediateSleep();
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<{ climbs: Climb[]; hasMore: boolean }>>()
      .mockResolvedValueOnce({ climbs: makePage(0, 2), hasMore: true })
      .mockRejectedValue(new Error('User not found'));

    await expect(
      drainPlaylistPages({
        fetchPage,
        signal: new AbortController().signal,
        pageSize: 2,
        maxPages: 30,
        isRetryable: (error) => error instanceof TypeError,
        parseRetryAfterSeconds: noRateLimit,
        sleep,
      }),
    ).rejects.toThrow('User not found');

    // Page 0 once, page 1 once. No retry of page 1.
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after PLAYLIST_PAGE_MAX_ATTEMPTS on a persistent transport error', async () => {
    const sleep = makeImmediateSleep();
    const fetchPage = vi.fn(async () => {
      throw makeTransportError();
    });

    await expect(
      drainPlaylistPages({
        fetchPage,
        signal: new AbortController().signal,
        pageSize: 100,
        maxPages: 30,
        isRetryable: () => true,
        parseRetryAfterSeconds: noRateLimit,
        sleep,
      }),
    ).rejects.toThrow('Network request failed');

    expect(fetchPage).toHaveBeenCalledTimes(PLAYLIST_PAGE_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(PLAYLIST_PAGE_MAX_ATTEMPTS - 1);
  });

  it('waits out a short RATE_LIMITED and re-issues the same page', async () => {
    const sleep = makeImmediateSleep();
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<{ climbs: Climb[]; hasMore: boolean }>>()
      .mockRejectedValueOnce(makeRateLimitError(2))
      .mockResolvedValueOnce({ climbs: makePage(0, 2), hasMore: false });

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: 2,
      maxPages: 30,
      isRetryable: neverRetryable,
      parseRetryAfterSeconds: (error) => parseRetryAfterSecondsForTest(error),
      sleep,
      random: () => 0,
    });

    expect(result.stopReason).toBe('complete');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(2000);
  });

  it('fails fast on a RATE_LIMITED that asks for longer than the ceiling', async () => {
    const sleep = makeImmediateSleep();
    const fetchPage = vi.fn(async () => {
      throw makeRateLimitError(46);
    });

    await expect(
      drainPlaylistPages({
        fetchPage,
        signal: new AbortController().signal,
        pageSize: 100,
        maxPages: 30,
        isRetryable: () => true,
        parseRetryAfterSeconds: (error) => parseRetryAfterSecondsForTest(error),
        sleep,
      }),
    ).rejects.toThrow(/Rate limit exceeded/);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(46_000).toBeGreaterThan(PLAYLIST_RATE_LIMIT_MAX_WAIT_MS);
  });

  it('propagates an AbortError from a page without retrying it', async () => {
    const sleep = makeImmediateSleep();
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const fetchPage = vi.fn(async () => {
      throw abortError;
    });

    await expect(
      drainPlaylistPages({
        fetchPage,
        signal: new AbortController().signal,
        pageSize: 100,
        maxPages: 30,
        // Deliberately permissive: abort must win over the retry predicate.
        isRetryable: () => true,
        parseRetryAfterSeconds: noRateLimit,
        sleep,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // Without this, an aborted activation resolves seconds later and stomps a queue
  // the climber has already moved on from.
  it('aborts during the default sleep, clears its timer and never resolves late', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => {
      throw makeTransportError();
    });

    const drainPromise = drainPlaylistPages({
      fetchPage,
      signal: controller.signal,
      pageSize: 100,
      maxPages: 30,
      isRetryable: () => true,
      parseRetryAfterSeconds: noRateLimit,
      // No `sleep` override: this exercises the real abortable sleep.
    });
    const settled = drainPromise.then(
      () => 'resolved' as const,
      (error: unknown) => (isAbortError(error) ? ('aborted' as const) : ('rejected' as const)),
    );

    // Let the first fetchPage rejection land and the retry sleep start.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(settled).resolves.toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not fetch anything when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchPage = vi.fn(async () => ({ climbs: makePage(0, 2), hasMore: true }));

    const result = await drainPlaylistPages({
      fetchPage,
      signal: controller.signal,
      pageSize: 2,
      maxPages: 30,
      isRetryable: neverRetryable,
      parseRetryAfterSeconds: noRateLimit,
      sleep: makeImmediateSleep(),
    });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('aborted');
    expect(result.climbs).toEqual([]);
  });
});

describe('fetchPlaylistSuggestionClimbs', () => {
  it('keeps its 10-page cap', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
      climbs: makePage(page, 1),
      hasMore: true,
    }));

    const climbs = await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'not-in-this-list',
      signal: new AbortController().signal,
      fetchPage,
      pageSize: 1,
    });

    expect(fetchPage).toHaveBeenCalledTimes(10);
    expect(climbs).toHaveLength(10);
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ page: 0, pageSize: 1 });
  });

  it('defaults to the shared refresh page size', async () => {
    const fetchPage = vi.fn(async (_args: { page: number; pageSize: number; signal: AbortSignal }) => ({
      climbs: makePage(0, 1),
      hasMore: false,
    }));

    await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'p0-c0',
      signal: new AbortController().signal,
      fetchPage,
    });

    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ pageSize: PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE });
  });

  it('stops once maxClimbsAfterActivated climbs follow the activated climb', async () => {
    // Page 0 holds the activated climb; every later page adds 10 more after it.
    const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
      climbs: page === 0 ? [makeClimb('activated'), ...makePage(0, 9)] : makePage(page, 10),
      hasMore: true,
    }));

    const climbs = await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'activated',
      signal: new AbortController().signal,
      fetchPage,
      pageSize: 10,
      maxPages: 100,
      maxClimbsAfterActivated: 25,
    });

    // 9 after the activated climb on page 0, +10 on page 1, +10 on page 2 = 29 >= 25.
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(climbs).toHaveLength(30);
  });

  it('does not count climbs loaded before the activated climb is seen', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => ({
      climbs: page === 2 ? [makeClimb('activated'), ...makePage(2, 9)] : makePage(page, 10),
      hasMore: true,
    }));

    await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'activated',
      signal: new AbortController().signal,
      fetchPage,
      pageSize: 10,
      maxPages: 100,
      maxClimbsAfterActivated: 25,
    });

    // Pages 0 and 1 are "before"; counting starts on page 2 (9), then 10, then 10.
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });

  it('does not double-count a page that was retried', async () => {
    const sleep = makeImmediateSleep();
    let page1Attempts = 0;
    const fetchPage = vi.fn(async ({ page }: { page: number }) => {
      if (page === 1) {
        page1Attempts += 1;
        if (page1Attempts === 1) throw makeTransportError();
      }
      return {
        climbs: page === 0 ? [makeClimb('activated'), ...makePage(0, 9)] : makePage(page, 10),
        hasMore: true,
      };
    });

    const climbs = await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'activated',
      signal: new AbortController().signal,
      fetchPage,
      pageSize: 10,
      maxPages: 100,
      maxClimbsAfterActivated: 25,
      isRetryable: (error) => error instanceof TypeError,
      sleep,
    });

    // Same stop point as the un-retried run above: page 2 tips it over 25.
    // 4 calls = 3 pages + 1 retry.
    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(climbs).toHaveLength(30);
  });

  it('stops mid-drain when the signal aborts between pages', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async ({ page }: { page: number }) => {
      if (page === 1) controller.abort();
      return { climbs: makePage(page, 10), hasMore: true };
    });

    const climbs = await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'nope',
      signal: controller.signal,
      fetchPage,
      pageSize: 10,
      maxPages: 100,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(climbs).toHaveLength(20);
  });
});

/**
 * Local stand-in for `parseRateLimitError` from `@boardsesh/graphql-client`.
 * The drainer takes the predicate as a parameter precisely so this package needs
 * no dependency on it; the mobile hook injects the real one.
 */
function parseRetryAfterSecondsForTest(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const response = (error as { response?: { errors?: unknown } }).response;
  if (!response || !Array.isArray(response.errors)) return null;
  for (const entry of response.errors as Array<{ extensions?: { code?: unknown; retryAfterSeconds?: unknown } }>) {
    if (entry?.extensions?.code === 'RATE_LIMITED' && typeof entry.extensions.retryAfterSeconds === 'number') {
      return entry.extensions.retryAfterSeconds;
    }
  }
  return null;
}
