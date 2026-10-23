import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, PlaylistSuggestionSource, PlaylistTrackPage } from '@boardsesh/queue';

const privacy = vi.hoisted(() => ({ generation: 0 }));
vi.mock('../../privacy/privacy-cache', () => ({ getPrivacyRevocationGeneration: () => privacy.generation }));

import {
  _resetTrackPagerForTests,
  canLoadMoreOfTrack,
  loadNextTrackPage,
  pinTrackLoader,
  registerPendingTrackLoader,
  registerTrackPageLoader,
  trackForCounting,
  type TrackPageLoader,
} from '../track-pager';

function track(loaderId: string | null, nextPage = 1): PlaylistSuggestionSource {
  return {
    playlistUuid: 'playlist:p',
    activatedClimbUuid: 'a',
    boardKey: 'k',
    climbs: [{ uuid: 'a' } as Climb],
    ...(loaderId ? { continuation: { loaderId, nextPage } } : {}),
  };
}

function page(pageIndex: number): PlaylistTrackPage {
  return {
    page: pageIndex,
    pageSize: 1,
    climbs: [{ uuid: `c${pageIndex}` } as Climb],
    filteredOut: false,
    nextPage: pageIndex + 1,
  };
}

beforeEach(() => {
  privacy.generation = 0;
  _resetTrackPagerForTests();
  vi.restoreAllMocks();
});

// Issue #6664: the player asks for one page as the climber nears the end.
describe('track pager', () => {
  it('fetches the page the track continues from', async () => {
    const load = vi.fn<TrackPageLoader>(async (pageIndex) => page(pageIndex));
    const loaderId = registerTrackPageLoader(load);

    await expect(loadNextTrackPage(track(loaderId, 3))).resolves.toEqual(page(3));
    expect(load).toHaveBeenCalledWith(3, expect.any(AbortSignal));
  });

  it('sends one request for a page however often it is asked for while it is out', async () => {
    let release: (result: PlaylistTrackPage) => void = () => {};
    const load = vi.fn<TrackPageLoader>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const source = track(registerTrackPageLoader(load));

    const first = loadNextTrackPage(source);
    const second = loadNextTrackPage(source);
    release(page(1));

    expect(await first).toEqual(page(1));
    expect(await second).toEqual(page(1));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('has nothing to load for a finished track or one whose loader is gone', async () => {
    expect(canLoadMoreOfTrack(track(null))).toBe(false);
    expect(canLoadMoreOfTrack(null)).toBe(false);
    // A track restored after a restart carries an id nobody registered.
    expect(canLoadMoreOfTrack(track('track-pages-restored'))).toBe(false);
    await expect(loadNextTrackPage(track('track-pages-restored'))).resolves.toBeNull();
  });

  it('ends the track where it is when a page fails, so the end card can show', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = track(
      registerTrackPageLoader(async () => {
        throw new Error('offline');
      }),
      2,
    );

    await expect(loadNextTrackPage(source)).resolves.toMatchObject({ climbs: [], nextPage: null });
  });

  it('drops a loader registered under an account that has since signed out', async () => {
    const load = vi.fn<TrackPageLoader>(async (pageIndex) => page(pageIndex));
    const source = track(registerTrackPageLoader(load));
    privacy.generation = 1;

    expect(canLoadMoreOfTrack(source)).toBe(false);
    await expect(loadNextTrackPage(source)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('never lands a page fetched for an account that signed out mid-request', async () => {
    let release: (result: PlaylistTrackPage) => void = () => {};
    const source = track(
      registerTrackPageLoader(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
    const pending = loadNextTrackPage(source);
    privacy.generation = 1;
    release(page(1));

    await expect(pending).resolves.toBeNull();
  });

  it('forgets the loader used longest ago once there are too many', () => {
    const first = registerTrackPageLoader(async (pageIndex) => page(pageIndex));
    for (let index = 0; index < 32; index += 1) registerTrackPageLoader(async (pageIndex) => page(pageIndex));
    expect(canLoadMoreOfTrack(track(first))).toBe(false);
  });

  it('keeps the loaders of the tracks the climber can reach, however many lists they peek at', () => {
    // A committed search track and a preview, then a run of crew-preview taps
    // that each register their own loader and never touch either track.
    const committed = track(registerTrackPageLoader(async (pageIndex) => page(pageIndex)));
    const preview = track(registerTrackPageLoader(async (pageIndex) => page(pageIndex)));
    pinTrackLoader('committed', committed);
    pinTrackLoader('preview', preview);
    for (let index = 0; index < 40; index += 1) registerTrackPageLoader(async (pageIndex) => page(pageIndex));
    expect(canLoadMoreOfTrack(committed)).toBe(true);
    expect(canLoadMoreOfTrack(preview)).toBe(true);
  });

  it('lets a released track be evicted', () => {
    const preview = track(registerTrackPageLoader(async (pageIndex) => page(pageIndex)));
    pinTrackLoader('preview', preview);
    pinTrackLoader('preview', null);
    for (let index = 0; index < 32; index += 1) registerTrackPageLoader(async (pageIndex) => page(pageIndex));
    expect(canLoadMoreOfTrack(preview)).toBe(false);
  });

  it('ends a track whose page failed without its count', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = track(
      registerTrackPageLoader(async () => {
        throw new Error('offline');
      }),
    );
    await expect(loadNextTrackPage(source)).resolves.toMatchObject({ nextPage: null, filteredOut: true });
  });
});

// "250 of 600" must never sit next to "That's the whole list" (#6664 review).
describe('trackForCounting', () => {
  it("drops the count of a track that has more but can't load it", () => {
    const restored = { ...track('track-pages-from-last-week-1'), total: 600 };
    expect(trackForCounting(restored)).not.toHaveProperty('total');
  });

  it('keeps the count while the rest can still load, and once the list is all loaded', () => {
    const loading = { ...track(registerTrackPageLoader(async (pageIndex) => page(pageIndex))), total: 600 };
    const complete = { ...track(null), total: 1 };
    expect(trackForCounting(loading)).toBe(loading);
    expect(trackForCounting(complete)).toBe(complete);
  });
});

// The background load after a tap is still out: the end of the rows on screen
// is not the end of the list, so the player must not say it is.
describe('a track whose list is still loading', () => {
  it('can load more until the load settles, then adds nothing when a fuller track replaced it', async () => {
    let settle: (replaced: boolean) => void = () => {};
    const settled = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const source = track(registerPendingTrackLoader(settled), 0);
    expect(canLoadMoreOfTrack(source)).toBe(true);

    const answer = loadNextTrackPage(source);
    settle(true);
    // Null lands nowhere, so it can't overwrite the fuller track.
    await expect(answer).resolves.toBeNull();
  });

  it('ends the track where it is, without its count, when the load did not replace it', async () => {
    const source = track(registerPendingTrackLoader(Promise.resolve(false)), 0);
    // `filteredOut` drops the count: the track stops short of the list it counted.
    await expect(loadNextTrackPage(source)).resolves.toEqual({
      page: 0,
      pageSize: 0,
      climbs: [],
      filteredOut: true,
      nextPage: null,
    });
  });

  it('ends the track where it is when the load failed', async () => {
    const source = track(registerPendingTrackLoader(Promise.reject(new Error('offline'))), 0);
    await expect(loadNextTrackPage(source)).resolves.toMatchObject({ climbs: [], nextPage: null });
  });
});
