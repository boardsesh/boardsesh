import { describe, it, expect, vi } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import {
  abortableSleep,
  drainPlaylistPages,
  PLAYLIST_QUEUE_REPLACE_MAX_PAGES,
  type DrainSleep,
  type PlaylistPage,
  type ShouldRetryPage,
} from '../drain-playlist-pages';

const PAGE_SIZE = 100;

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'test',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a/V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  } as unknown as Climb;
}

function makePage(pageIndex: number, count: number, hasMore: boolean): PlaylistPage {
  return {
    climbs: Array.from({ length: count }, (_unused, offset) => makeClimb(`p${pageIndex}-c${offset}`)),
    hasMore,
  };
}

/** Records every requested wait instead of burning wall-clock time. */
function createSleepRecorder(): { sleep: DrainSleep; waits: number[] } {
  const waits: number[] = [];
  const sleep: DrainSleep = async (ms) => {
    waits.push(ms);
  };
  return { sleep, waits };
}

function makeAbortError(): Error {
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  return abortError;
}

describe('drainPlaylistPages', () => {
  it('drains every page and reports complete', async () => {
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<PlaylistPage>>()
      .mockImplementation(async ({ page }) => makePage(page, 2, page < 2));

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: PAGE_SIZE,
    });

    expect(result.pagesFetched).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.stoppedBy).toBe('exhausted');
    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['p0-c0', 'p0-c1', 'p1-c0', 'p1-c1', 'p2-c0', 'p2-c1']);
  });

  // Regression guard for the unbounded `while (hasMore)` loop (#4622): a
  // playlist bigger than the server budget — or a resolver that never stops
  // saying `hasMore` — must stop the client, not spin it.
  it('stops at the page cap and reports it', async () => {
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<PlaylistPage>>()
      .mockImplementation(async ({ page }) => makePage(page, PAGE_SIZE, true));

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: PAGE_SIZE,
      maxPages: PLAYLIST_QUEUE_REPLACE_MAX_PAGES,
    });

    expect(fetchPage).toHaveBeenCalledTimes(30);
    expect(result.pagesFetched).toBe(30);
    expect(result.climbs).toHaveLength(3000);
    expect(result.complete).toBe(false);
    expect(result.stoppedBy).toBe('page-cap');
  });

  // THE CORE CASE. The old drain restarted at page 0 on any failure, throwing
  // away everything already fetched and spending the server budget twice.
  it('resumes from the failed page instead of restarting', async () => {
    const requestedPages: number[] = [];
    let page2Failures = 0;
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<PlaylistPage>>()
      .mockImplementation(async ({ page }) => {
        requestedPages.push(page);
        if (page === 2 && page2Failures === 0) {
          page2Failures += 1;
          throw new Error('Rate limit exceeded. Try again in 5 seconds.');
        }
        return makePage(page, 1, page < 3);
      });
    const { sleep, waits } = createSleepRecorder();
    const shouldRetryPage: ShouldRetryPage = (_error, attempt) => (attempt === 0 ? 5_000 : null);

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: PAGE_SIZE,
      shouldRetryPage,
      sleep,
    });

    expect(requestedPages).toEqual([0, 1, 2, 2, 3]);
    expect(waits).toEqual([5_000]);
    expect(result.stoppedBy).toBe('exhausted');
    expect(result.complete).toBe(true);
    expect(result.pagesFetched).toBe(4);
    // Pages 0 and 1 survived the failure on page 2.
    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['p0-c0', 'p1-c0', 'p2-c0', 'p3-c0']);
  });

  it('gives up on a page after the injected policy says stop, and returns the partial', async () => {
    const pageError = new Error('still broken');
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<PlaylistPage>>()
      .mockImplementation(async ({ page }) => {
        if (page === 2) throw pageError;
        return makePage(page, PAGE_SIZE, true);
      });
    const { sleep } = createSleepRecorder();

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: PAGE_SIZE,
      shouldRetryPage: () => null,
      sleep,
    });

    expect(result.pagesFetched).toBe(2);
    expect(result.climbs).toHaveLength(200);
    expect(result.complete).toBe(false);
    expect(result.stoppedBy).toBe('error');
    expect(result.error).toBe(pageError);
  });

  // "Cannot hang forever": the whole drain shares one wall-clock sleep budget.
  it('stops when the total wait budget is exhausted', async () => {
    const pageError = new Error('Rate limit exceeded. Try again in 45 seconds.');
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<PlaylistPage>>()
      .mockImplementation(async ({ page }) => {
        if (page === 1) throw pageError;
        return makePage(page, PAGE_SIZE, true);
      });
    const { sleep, waits } = createSleepRecorder();

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: PAGE_SIZE,
      shouldRetryPage: () => 45_000,
      sleep,
      maxTotalWaitMs: 60_000,
    });

    // First retry fits (45s of 60s). The second asks for another 45s against a
    // 15s remainder, so the drain stops instead of sleeping past its ceiling.
    expect(waits).toEqual([45_000]);
    expect(result.stoppedBy).toBe('wait-budget');
    expect(result.complete).toBe(false);
    expect(result.pagesFetched).toBe(1);
    expect(result.climbs).toHaveLength(100);
    expect(result.error).toBe(pageError);
  });

  it('returns the partial and stops issuing pages when the caller aborts mid-drain', async () => {
    const controller = new AbortController();
    const fetchPage = vi
      .fn<(args: { page: number }) => Promise<PlaylistPage>>()
      .mockImplementation(async ({ page }) => {
        if (page === 1) controller.abort();
        return makePage(page, 1, true);
      });

    const result = await drainPlaylistPages({
      fetchPage,
      signal: controller.signal,
      pageSize: PAGE_SIZE,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.stoppedBy).toBe('aborted');
    expect(result.complete).toBe(false);
    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['p0-c0', 'p1-c0']);
  });

  it('never retries an AbortError from the page fetcher', async () => {
    const shouldRetryPage = vi.fn<ShouldRetryPage>().mockReturnValue(1_000);
    const fetchPage = vi.fn<(args: { page: number }) => Promise<PlaylistPage>>().mockRejectedValue(makeAbortError());
    const { sleep, waits } = createSleepRecorder();

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: PAGE_SIZE,
      shouldRetryPage,
      sleep,
    });

    expect(shouldRetryPage).not.toHaveBeenCalled();
    expect(waits).toEqual([]);
    expect(result.stoppedBy).toBe('aborted');
    expect(result.climbs).toEqual([]);
  });

  it("preserves today's fail-fast behaviour when no retry policy is injected", async () => {
    const pageError = new Error('boom');
    const fetchPage = vi.fn<(args: { page: number }) => Promise<PlaylistPage>>().mockRejectedValue(pageError);
    const { sleep, waits } = createSleepRecorder();

    const result = await drainPlaylistPages({
      fetchPage,
      signal: new AbortController().signal,
      pageSize: PAGE_SIZE,
      sleep,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(result.stoppedBy).toBe('error');
    expect(result.error).toBe(pageError);
  });
});

describe('abortableSleep', () => {
  it('settles immediately on abort instead of waiting the backoff out', async () => {
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const startedAt = Date.now();

    const pendingSleep = abortableSleep(5_000, controller.signal);
    controller.abort();

    await expect(pendingSleep).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // `once` is what removes the listener when it fires; clearing the timer is
    // what stops a cancelled activation leaving a 5s timeout behind.
    expect(addEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(clearTimeoutSpy).toHaveBeenCalled();

    addEventListenerSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('removes its abort listener when the wait completes normally', async () => {
    const controller = new AbortController();
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await abortableSleep(1, controller.signal);

    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    removeEventListenerSpy.mockRestore();
  });

  it('rejects straight away when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(abortableSleep(5_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
