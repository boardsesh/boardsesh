import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, PlaylistSuggestionSource, PlaylistTrackPage } from '@boardsesh/queue';

const privacy = vi.hoisted(() => ({ generation: 0 }));
vi.mock('../../privacy/privacy-cache', () => ({ getPrivacyRevocationGeneration: () => privacy.generation }));

import {
  _resetTrackPagerForTests,
  canLoadMoreOfTrack,
  loadNextTrackPage,
  registerPendingTrackLoader,
  registerTrackPageLoader,
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

  it('keeps the loader of a track the climber is walking, however many lists they peek at', () => {
    // A committed search track, then a run of crew-preview taps that each
    // register their own loader. The walked track asks after its loader as the
    // climber goes, which keeps it from being the one evicted.
    const walked = registerTrackPageLoader(async (pageIndex) => page(pageIndex));
    for (let index = 0; index < 40; index += 1) {
      registerTrackPageLoader(async (pageIndex) => page(pageIndex));
      expect(canLoadMoreOfTrack(track(walked))).toBe(true);
    }
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

  it('ends the track where it is when the load did not replace it', async () => {
    const source = track(registerPendingTrackLoader(Promise.resolve(false)), 0);
    await expect(loadNextTrackPage(source)).resolves.toEqual({
      page: 0,
      pageSize: 0,
      climbs: [],
      filteredOut: false,
      nextPage: null,
    });
  });

  it('ends the track where it is when the load failed', async () => {
    const source = track(registerPendingTrackLoader(Promise.reject(new Error('offline'))), 0);
    await expect(loadNextTrackPage(source)).resolves.toMatchObject({ climbs: [], nextPage: null });
  });
});
