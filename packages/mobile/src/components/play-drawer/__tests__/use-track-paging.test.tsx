// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaylistSuggestionSource, type Climb, type PlaylistSuggestionSource } from '@boardsesh/queue';

vi.mock('../../../lib/privacy/privacy-cache', () => ({ getPrivacyRevocationGeneration: () => 0 }));

import {
  _resetTrackPagerForTests,
  canLoadMoreOfTrack,
  registerTrackPageLoader,
  type TrackPageLoader,
} from '../../../lib/playlists/track-pager';
import { TRACK_PAGE_LOOKAHEAD, useTrackPaging } from '../use-track-paging';

const PAGE_SIZE = 30;

function climbsOf(pageIndex: number): Climb[] {
  return Array.from({ length: PAGE_SIZE }, (_, index) => ({ uuid: `p${pageIndex}-${index}` }) as Climb);
}

function trackWith(loaderId: string): PlaylistSuggestionSource {
  const climbs = climbsOf(0);
  return createPlaylistSuggestionSource({
    playlistUuid: 'playlist:p',
    activatedClimb: climbs[0],
    climbs,
    boardKey: 'k',
    label: 'Projects',
    total: 90,
    continuation: { loaderId, nextPage: 1 },
  });
}

const loadPage = vi.fn<TrackPageLoader>(async (page) => ({
  page,
  pageSize: PAGE_SIZE,
  climbs: climbsOf(page),
  filteredOut: false,
  nextPage: page + 1 < 3 ? page + 1 : null,
  total: 90,
}));

beforeEach(() => {
  _resetTrackPagerForTests();
  loadPage.mockClear();
});

function render(
  source: PlaylistSuggestionSource,
  listClimbUuid: string,
  previewTrack = false,
  committedSource: PlaylistSuggestionSource = source,
) {
  const setPreviewSource = vi.fn();
  const refreshCommittedSource = vi.fn();
  const view = renderHook(
    (props: { displayed: string }) =>
      useTrackPaging({
        source,
        listClimbUuid: props.displayed,
        previewTrack,
        setPreviewSource,
        getCommittedSource: () => committedSource,
        refreshCommittedSource,
      }),
    { initialProps: { displayed: listClimbUuid } },
  );
  return { ...view, setPreviewSource, refreshCommittedSource };
}

// Issue #6664: a long list keeps going, one page as the climber nears its end.
describe('useTrackPaging', () => {
  it('waits until the climber is near the end of what is loaded', () => {
    const source = trackWith(registerTrackPageLoader(loadPage));
    const farFromEnd = source.climbs[PAGE_SIZE - TRACK_PAGE_LOOKAHEAD - 2].uuid;

    render(source, farFromEnd);

    expect(loadPage).not.toHaveBeenCalled();
  });

  it('keeps the walked track pageable however many other lists register loaders', () => {
    // The player sits mid-list, nowhere near the end, while crew-preview taps
    // elsewhere each register a loader (#6664 second review).
    const source = trackWith(registerTrackPageLoader(loadPage));
    render(source, source.climbs[0].uuid);

    for (let index = 0; index < 40; index += 1) registerTrackPageLoader(loadPage);

    expect(canLoadMoreOfTrack(source)).toBe(true);
  });

  it('asks for the next page near the end and lands it on the committed track', async () => {
    const source = trackWith(registerTrackPageLoader(loadPage));
    const { refreshCommittedSource } = render(source, source.climbs[PAGE_SIZE - 3].uuid);

    await waitFor(() => expect(refreshCommittedSource).toHaveBeenCalledTimes(1));
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith(1, expect.any(AbortSignal));
    const extended = refreshCommittedSource.mock.calls[0][0] as PlaylistSuggestionSource;
    expect(extended.climbs).toHaveLength(PAGE_SIZE * 2);
    expect(extended.continuation).toMatchObject({ nextPage: 2 });
    // Pages from the top, in line: the count still holds.
    expect(extended.total).toBe(90);
  });

  it('sends one request while the climber keeps swiping toward the end', async () => {
    const source = trackWith(registerTrackPageLoader(loadPage));
    const { rerender, refreshCommittedSource } = render(source, source.climbs[PAGE_SIZE - 3].uuid);
    rerender({ displayed: source.climbs[PAGE_SIZE - 2].uuid });
    rerender({ displayed: source.climbs[PAGE_SIZE - 1].uuid });

    await waitFor(() => expect(refreshCommittedSource).toHaveBeenCalled());
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("lands a preview's page on the preview's own track", async () => {
    const source = trackWith(registerTrackPageLoader(loadPage));
    const { setPreviewSource, refreshCommittedSource } = render(source, source.climbs[PAGE_SIZE - 1].uuid, true);

    await waitFor(() => expect(setPreviewSource).toHaveBeenCalledTimes(1));
    expect(refreshCommittedSource).not.toHaveBeenCalled();
    const update = setPreviewSource.mock.calls[0][0] as (current: PlaylistSuggestionSource | null) => unknown;
    expect((update(source) as PlaylistSuggestionSource).climbs).toHaveLength(PAGE_SIZE * 2);
    // A track the climber replaced meanwhile is left alone.
    const replaced = { ...source, continuation: { loaderId: 'other', nextPage: 1 } };
    expect(update(replaced)).toBe(replaced);
    expect(update(null)).toBeNull();
  });

  it('leaves a committed track alone that no longer ends where the page was asked for', async () => {
    const source = trackWith(registerTrackPageLoader(loadPage));
    // A second answer already extended it, or a new list replaced it.
    const moved = { ...source, continuation: { loaderId: source.continuation!.loaderId, nextPage: 2 } };
    const { refreshCommittedSource } = render(source, source.climbs[PAGE_SIZE - 1].uuid, false, moved);

    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));
    // Let the answer land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshCommittedSource).not.toHaveBeenCalled();
  });

  // PR #6700 review: a logbook's run of repeat-only pages answers with no climbs
  // and the same place to carry on from. Landing that would rerun the request
  // with no swipe, page after page.
  const stalledPage = vi.fn<TrackPageLoader>(async (page) => ({
    page,
    pageSize: 1,
    climbs: [],
    filteredOut: false,
    nextPage: page,
  }));

  it('asks once per swipe while pages add nothing and climbs are still ahead', async () => {
    stalledPage.mockClear();
    const source = trackWith(registerTrackPageLoader(stalledPage));
    const { rerender, refreshCommittedSource } = render(source, source.climbs[PAGE_SIZE - 3].uuid);

    await waitFor(() => expect(stalledPage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshCommittedSource).not.toHaveBeenCalled();
    expect(stalledPage).toHaveBeenCalledTimes(1);

    rerender({ displayed: source.climbs[PAGE_SIZE - 2].uuid });
    await waitFor(() => expect(stalledPage).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshCommittedSource).not.toHaveBeenCalled();
  });

  it('lands a page that adds nothing when the climber waits on the last climb', async () => {
    stalledPage.mockClear();
    const source = trackWith(registerTrackPageLoader(stalledPage));
    const { refreshCommittedSource } = render(source, source.climbs[PAGE_SIZE - 1].uuid);

    // Next waits on the track, so it keeps asking until a climb or the end.
    await waitFor(() => expect(refreshCommittedSource).toHaveBeenCalledTimes(1));
    const landed = refreshCommittedSource.mock.calls[0][0] as PlaylistSuggestionSource;
    expect(landed.climbs).toHaveLength(PAGE_SIZE);
    expect(landed.continuation).toMatchObject({ nextPage: 1 });
  });

  it('does nothing for a track that has ended', () => {
    const ended = trackWith(registerTrackPageLoader(loadPage));
    delete ended.continuation;
    render(ended, ended.climbs[PAGE_SIZE - 1].uuid);

    expect(loadPage).not.toHaveBeenCalled();
  });
});
