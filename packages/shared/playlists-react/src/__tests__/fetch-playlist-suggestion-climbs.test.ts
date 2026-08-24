import { describe, it, expect, vi } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import {
  fetchPlaylistSuggestionClimbs,
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
} from '../fetch-playlist-suggestion-climbs';
import type { DrainSleep, PlaylistPage, ShouldRetryPage } from '../drain-playlist-pages';

function makeClimb(uuid: string): Climb {
  return { uuid, name: `Climb ${uuid}`, angle: 40 } as unknown as Climb;
}

function makePage(pageIndex: number, count: number, hasMore: boolean): PlaylistPage {
  return {
    climbs: Array.from({ length: count }, (_unused, offset) => makeClimb(`p${pageIndex}-c${offset}`)),
    hasMore,
  };
}

function createSleepRecorder(): { sleep: DrainSleep; waits: number[] } {
  const waits: number[] = [];
  const sleep: DrainSleep = async (ms) => {
    waits.push(ms);
  };
  return { sleep, waits };
}

describe('fetchPlaylistSuggestionClimbs', () => {
  it('retries a dropped page and resumes on the same page', async () => {
    const requestedPages: number[] = [];
    let page1Failures = 0;
    const fetchPage = vi.fn(async ({ page }: { page: number }) => {
      requestedPages.push(page);
      if (page === 1 && page1Failures === 0) {
        page1Failures += 1;
        throw new Error('dropped');
      }
      return makePage(page, 2, page < 2);
    });
    const { sleep, waits } = createSleepRecorder();

    const climbs = await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'p0-c0',
      signal: new AbortController().signal,
      fetchPage,
      createPageRetryPolicy: () => (_error, attempt) => (attempt === 0 ? 400 : null),
      sleep,
    });

    expect(requestedPages).toEqual([0, 1, 1, 2]);
    expect(waits).toEqual([400]);
    expect(climbs).toHaveLength(6);
  });

  // The refresh is fire-and-forget behind the play drawer. Without a shared
  // ceiling, every one of its pages could sleep a full server window and leave
  // the prefetch pending for minutes.
  it('stops on its total wait budget and returns what it already has', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => {
      if (page >= 1) throw new Error('Rate limit exceeded');
      return makePage(page, 3, true);
    });
    const { sleep, waits } = createSleepRecorder();

    const climbs = await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'p0-c0',
      signal: new AbortController().signal,
      fetchPage,
      // A policy that keeps asking for 45s. Bounded at three asks purely so a
      // regression here FAILS instead of spinning the suite: with no budget the
      // walk would sleep on every ask, then propagate page 1's rejection.
      createPageRetryPolicy: () => {
        let asks = 0;
        return () => (asks++ < 3 ? 45_000 : null);
      },
      maxTotalWaitMs: 60_000,
      sleep,
    });

    // 45s of the 60s budget is spent on page 1's first retry; the second ask
    // does not fit, so the refresh ends with page 0's climbs instead of hanging.
    expect(waits).toEqual([45_000]);
    expect(climbs.map((climb) => climb.uuid)).toEqual(['p0-c0', 'p0-c1', 'p0-c2']);
  });

  it('still propagates a page rejection the policy gave up on', async () => {
    const pageError = new Error('Invalid playlist input');
    const fetchPage = vi.fn(async ({ page }: { page: number }) => {
      if (page === 1) throw pageError;
      return makePage(page, 1, true);
    });
    const giveUp: ShouldRetryPage = () => null;

    await expect(
      fetchPlaylistSuggestionClimbs({
        activatedClimbUuid: 'p0-c0',
        signal: new AbortController().signal,
        fetchPage,
        createPageRetryPolicy: () => giveUp,
        sleep: async () => {},
      }),
    ).rejects.toBe(pageError);
  });

  it('requests the shared page size by default', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => makePage(page, 1, false));

    await fetchPlaylistSuggestionClimbs({
      activatedClimbUuid: 'p0-c0',
      signal: new AbortController().signal,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0, pageSize: PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE }),
    );
  });
});
