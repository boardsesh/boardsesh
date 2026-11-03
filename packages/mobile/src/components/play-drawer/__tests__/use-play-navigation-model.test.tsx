// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { planPlayNext, withoutListWalkFlag } from '@boardsesh/queue';
import enSession from '@boardsesh/i18n/locales/en-US/session.json';
import { getBoardConfigForPlaylist } from '../../../lib/playlists/board-details-for-playlist';
import { registerTrackPageLoader } from '../../../lib/playlists/track-pager';
import type { BoardConfig } from '../play-drawer-types';
import { resolveUpNextFirstCaption } from '../then-signposts';
import { usePlayNavigationModel } from '../use-play-navigation-model';

function knownBoard(boardType: string, layoutId: number): BoardConfig {
  const config = getBoardConfigForPlaylist(boardType, layoutId);
  if (!config) throw new Error(`Unknown board ${boardType}:${layoutId}`);
  return { ...config, setIds: config.setIds.join(','), angle: 40 };
}
const kilterBoard = knownBoard('kilter', 1);

function item(uuid: string, frames = `p${uuid}r12`, boardType = 'kilter', layoutId = 1): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames,
      boardType,
      layoutId,
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}
function inputs(queue: ClimbQueueItem[]) {
  return {
    queue,
    displayedQueueItem: queue[0] ?? null,
    displayedClimb: queue[0]?.climb,
    drawerPreviewItem: null as ClimbQueueItem | null,
    drawerPreviewSuggestionSource: null as PlaylistSuggestionSource | null,
    currentClimbQueueItem: queue[0] ?? null,
    playlistSuggestionSource: null as PlaylistSuggestionSource | null,
    activeBoardForNavigation: { boardType: 'kilter', layoutId: 1 },
    boardConfig: kilterBoard,
    renderBoardConfig: kilterBoard,
    isReachableClimb: undefined as ((climb: ClimbQueueItem['climb']) => boolean) | undefined,
    enhancementsReady: true,
  };
}

describe('usePlayNavigationModel', () => {
  it('keeps warming array identity through equivalent queue broadcasts, capped at three ahead', () => {
    const queue = [item('1'), item('2'), item('3'), item('4'), item('5')];
    const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps: inputs(queue) });
    const warmed = result.current.upcomingPrefetchFrames;
    expect(warmed).toEqual(['p2r12', 'p3r12', 'p4r12']);
    rerender(inputs([...queue]));
    expect(result.current.upcomingPrefetchFrames).toBe(warmed);
  });

  it('computes immediate targets while deferring remaining counts and warming', () => {
    const initialProps = { ...inputs([item('1'), item('2')]), enhancementsReady: false };
    const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps });
    expect(result.current.navigationState.nextItem?.climb.uuid).toBe('2');
    expect(result.current.navigationState.remainingCount).toBe(0);
    const empty = result.current.upcomingPrefetchFrames;
    rerender({ ...initialProps, queue: [...initialProps.queue] });
    expect(result.current.upcomingPrefetchFrames).toBe(empty);
    rerender({ ...initialProps, enhancementsReady: true });
    expect(result.current.navigationState.remainingCount).toBe(1);
    expect(result.current.upcomingPrefetchFrames).toEqual(['p2r12']);
  });

  it('does not warm displayed, duplicate, or multi-frame overlays', () => {
    const queue = [item('1', 'p1r12'), item('2', 'p1r12'), item('3', 'p3r12,p4r12'), item('4', 'p1r12')];
    const { result } = renderHook(() => usePlayNavigationModel(inputs(queue)));
    expect(result.current.upcomingPrefetchFrames).toEqual([]);
  });

  it('deduplicates equal frames without replacing the warming array on queue object refresh', () => {
    const queue = [item('1'), item('2', 'p8r12'), item('3', 'p8r12'), item('4', 'p9r12')];
    const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps: inputs(queue) });
    const warmed = result.current.upcomingPrefetchFrames;
    expect(warmed).toEqual(['p8r12', 'p9r12']);
    rerender(inputs(queue.map((queued) => ({ ...queued, climb: { ...queued.climb } }))));
    expect(result.current.upcomingPrefetchFrames).toBe(warmed);
  });

  it('navigates against the active wall even while a foreign board is displayed', () => {
    const current = item('1', 'p1r12', 'tension', 9);
    const next = item('2');
    const foreignBoard = knownBoard('tension', 9);
    const { result } = renderHook(() =>
      usePlayNavigationModel({
        ...inputs([current, next]),
        boardConfig: foreignBoard,
        renderBoardConfig: foreignBoard,
      }),
    );
    expect(result.current.navigationState.nextItem).toBe(next);
    expect(result.current.nextHeaderBoard.boardName).toBe('kilter');
    expect(result.current.nextPeekFrames).toBeNull();
    expect(result.current.upcomingPrefetchFrames).toEqual([]);
  });

  it('allows reachable foreign navigation but withholds its holds from the current wall', () => {
    const queue = [item('1'), item('2', 'p2r12', 'tension', 9), item('3')];
    const { result } = renderHook(() =>
      usePlayNavigationModel({
        ...inputs(queue),
        isReachableClimb: (climb) => climb.boardType === 'tension',
      }),
    );
    expect(result.current.navigationState.nextItem).toBe(queue[1]);
    expect(result.current.nextPeekFrames).toBeNull();
    expect(result.current.upcomingPrefetchFrames).toEqual(['p3r12']);
  });

  it('keeps preview lineage separate from the committed playlist', () => {
    const queue = [item('1'), item('2')];
    const preview = item('3');
    const committedSource: PlaylistSuggestionSource = {
      playlistUuid: 'committed',
      activatedClimbUuid: '1',
      boardKey: 'kilter:1',
      climbs: queue.map((queued) => queued.climb),
    };
    const previewSource: PlaylistSuggestionSource = {
      playlistUuid: 'preview',
      activatedClimbUuid: '3',
      boardKey: 'kilter:1',
      climbs: [preview.climb, item('4').climb],
    };
    const initialProps = {
      ...inputs(queue),
      drawerPreviewItem: preview,
      displayedQueueItem: preview,
      displayedClimb: preview.climb,
      playlistSuggestionSource: committedSource,
    };
    const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps });
    expect(result.current.navigationSuggestionSource).toBeNull();
    rerender({ ...initialProps, drawerPreviewSuggestionSource: previewSource });
    expect(result.current.navigationSuggestionSource).toBe(previewSource);
    expect(result.current.navigationState.nextItem?.climb.uuid).toBe('4');
  });

  it('drops a committed playlist after leaving its anchor lineage', () => {
    const queue = [item('1'), item('2')];
    const source: PlaylistSuggestionSource = {
      playlistUuid: 'old',
      activatedClimbUuid: '3',
      boardKey: 'kilter:1',
      climbs: [item('3').climb, item('4').climb],
    };
    const { result } = renderHook(() => usePlayNavigationModel({ ...inputs(queue), playlistSuggestionSource: source }));
    expect(result.current.navigationSuggestionSource).toBeNull();
    expect(result.current.navigationState.nextItem).toBe(queue[1]);
  });

  // #6238: walking a list, the queue button badges Up next, the same number
  // the end card offers.
  describe('the Up next badge', () => {
    const now = item('a');
    const queued = [item('q1'), item('q2')];
    const queue = [now, ...queued];
    const projects: PlaylistSuggestionSource = {
      playlistUuid: 'smart:projects',
      activatedClimbUuid: 'a',
      boardKey: 'kilter:1',
      climbs: [now.climb, item('b').climb, item('c').climb],
      label: 'Projects',
      total: 3,
    };

    it('counts Up next while a named list is walked, before its end', () => {
      const { result } = renderHook(() =>
        usePlayNavigationModel({ ...inputs(queue), playlistSuggestionSource: projects }),
      );
      expect(result.current.currentTrackLabel.kind).toBe('counted');
      expect(result.current.trackEndCard).toBeNull();
      expect(result.current.listWalkUpNextCount).toBe(2);
    });

    it('shows none while playing from the queue', () => {
      const { result } = renderHook(() => usePlayNavigationModel(inputs(queue)));
      expect(result.current.currentTrackLabel.kind).toBe('hidden');
      expect(result.current.listWalkUpNextCount).toBeNull();
    });

    // A crew preview opened from a list while the room's queue holds climbs
    // added with no Now: the whole queue is Up next, as the queue sheet says.
    it('counts the whole queue when the queue has no Now, end card included', () => {
      const preview = item('c');
      const { result } = renderHook(() =>
        usePlayNavigationModel({
          ...inputs(queued),
          displayedQueueItem: preview,
          displayedClimb: preview.climb,
          drawerPreviewItem: preview,
          drawerPreviewSuggestionSource: projects,
          currentClimbQueueItem: null,
        }),
      );
      expect(result.current.currentTrackLabel.kind).toBe('counted');
      expect(result.current.listWalkUpNextCount).toBe(2);
      // No Now to go back to: the card carries on into the queue.
      expect(result.current.trackEndCard).toEqual({
        listName: 'Projects',
        upNextCount: 2,
        firstUpNextName: 'Climb q1',
        backToName: null,
        action: { kind: 'nextInQueue', target: queued[0] },
      });
    });

    it('follows the queue as climbs are added', () => {
      const initialProps = { ...inputs(queue), playlistSuggestionSource: projects };
      const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps });
      rerender({ ...initialProps, queue: [...queue, item('q3')] });
      expect(result.current.listWalkUpNextCount).toBe(3);
    });
  });

  // #6777: what you queue plays before the list continues.
  describe('Up next in the middle of a list', () => {
    const onList = item('a');
    const queuedFirst = item('q1');
    const queuedSecond = item('q2');
    const queue = [onList, queuedFirst, queuedSecond];
    const results: PlaylistSuggestionSource = {
      playlistUuid: 'search',
      activatedClimbUuid: 'a',
      boardKey: 'kilter:1',
      climbs: [onList.climb, item('b').climb, item('c').climb],
      label: 'Search results',
      total: 3,
    };
    const walking: PlaylistSuggestionSource = {
      ...results,
      resume: { climbUuid: 'a', queueItemUuid: onList.uuid },
    };
    /** The model with `displayed` committed and the walk in Up next. */
    function playingUpNext(displayed: ClimbQueueItem, source: PlaylistSuggestionSource = walking) {
      return {
        ...inputs(queue),
        displayedQueueItem: displayed,
        displayedClimb: displayed.climb,
        currentClimbQueueItem: displayed,
        playlistSuggestionSource: source,
      };
    }

    it('swipes from a list climb into Up next first', () => {
      const { result } = renderHook(() =>
        usePlayNavigationModel({ ...inputs(queue), playlistSuggestionSource: results }),
      );
      expect(result.current.navigationState.nextItem).toBe(queuedFirst);
      // Up next, then the rest of the list.
      expect(result.current.navigationState.remainingCount).toBe(4);
    });

    // #7227: a step that only looks keeps walking this list, holding its place.
    // A step off the climb on the wall starts a look, and its list says so,
    // whichever way it goes (#7227 re-review).
    it('hands a look the list it walks, with its place in Up next', () => {
      const { result } = renderHook(() =>
        usePlayNavigationModel({ ...inputs(queue), playlistSuggestionSource: results }),
      );
      expect(result.current.nextPreviewSource).toEqual({ ...walking, lookOffWall: true });
      // Nothing before the list's first climb: the list as it is, marked.
      expect(result.current.previousPreviewSource).toEqual({ ...results, lookOffWall: true });
      expect(results).not.toHaveProperty('lookOffWall');
    });

    // A preview's own list (a list tap's) stays as it was opened: a step off
    // it is no look off the climb on the wall.
    it('leaves a preview’s own list unmarked', () => {
      const { result } = renderHook(() =>
        usePlayNavigationModel({
          ...inputs(queue),
          playlistSuggestionSource: results,
          drawerPreviewItem: onList,
          drawerPreviewSuggestionSource: results,
        }),
      );
      expect(result.current.nextPreviewSource).toEqual(walking);
      expect(result.current.previousPreviewSource).toBe(results);
    });

    it('hands a look no list when the walk has none, or a preview was opened with none', () => {
      const trackless = renderHook(() => usePlayNavigationModel(inputs(queue)));
      expect(trackless.result.current.nextPreviewSource).toBeNull();
      // #5403: a preview opened without a list never takes the committed one.
      const preview = renderHook(() =>
        usePlayNavigationModel({
          ...inputs(queue),
          playlistSuggestionSource: results,
          drawerPreviewItem: queuedFirst,
          displayedQueueItem: queuedFirst,
          displayedClimb: queuedFirst.climb,
        }),
      );
      expect(preview.result.current.nextPreviewSource).toBeNull();
      expect(preview.result.current.previousPreviewSource).toBeNull();
    });

    it('says "Up next · 1 of 2" while a queued climb plays, and comes back to the list after', () => {
      const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps: playingUpNext(queuedFirst) });
      expect(result.current.currentTrackLabel).toEqual({
        kind: 'upNext',
        listName: 'Search results',
        count: { position: 1, total: 2 },
        // The list carries on after Up next: "· then Search results".
        thenListName: 'Search results',
      });
      // The list keeps its place: Previous goes back to the list climb, the
      // last queued climb leads back onto the list.
      expect(result.current.navigationState.prevItem).toBe(onList);
      rerender(playingUpNext(queuedSecond));
      expect(result.current.currentTrackLabel).toMatchObject({ kind: 'upNext', count: { position: 2, total: 2 } });
      expect(result.current.navigationState.nextItem?.climb.uuid).toBe('b');
      rerender(playingUpNext(onList, results));
      expect(result.current.currentTrackLabel).toEqual({
        kind: 'counted',
        name: 'Search results',
        position: 1,
        total: 3,
      });
    });

    it('pages the list from where it picks up, not from the queued climb', () => {
      const { result } = renderHook(() => usePlayNavigationModel(playingUpNext(queuedSecond)));
      expect(result.current.trackListClimbUuid).toBe('a');
      const { result: onTheList } = renderHook(() =>
        usePlayNavigationModel({ ...inputs(queue), playlistSuggestionSource: results }),
      );
      expect(onTheList.current.trackListClimbUuid).toBe('a');
    });

    it('prefetches Up next, then the list', () => {
      const { result } = renderHook(() =>
        usePlayNavigationModel({ ...inputs(queue), playlistSuggestionSource: results }),
      );
      expect(result.current.upcomingPrefetchFrames).toEqual(['pq1r12', 'pq2r12', 'pbr12']);
    });

    it('shows the end card only once both the list and Up next are done', () => {
      const lastOnList = item('c');
      const endQueue = [lastOnList, queuedFirst];
      const endOfResults: PlaylistSuggestionSource = { ...results, activatedClimbUuid: 'c' };
      const { result: atListEnd } = renderHook(() =>
        usePlayNavigationModel({ ...inputs(endQueue), playlistSuggestionSource: endOfResults }),
      );
      expect(atListEnd.current.trackEndCard).toBeNull();
      expect(atListEnd.current.navigationState.nextItem).toBe(queuedFirst);

      const { result: bothDone } = renderHook(() =>
        usePlayNavigationModel({
          ...inputs(endQueue),
          displayedQueueItem: queuedFirst,
          displayedClimb: queuedFirst.climb,
          currentClimbQueueItem: queuedFirst,
          playlistSuggestionSource: { ...endOfResults, resume: { climbUuid: 'c', queueItemUuid: lastOnList.uuid } },
        }),
      );
      expect(bothDone.current.trackEndCard).toEqual({
        listName: 'Search results',
        upNextCount: 0,
        firstUpNextName: null,
        backToName: null,
        action: null,
      });
      // The list ended with Up next: nothing comes after it to name.
      expect(bothDone.current.currentTrackLabel).toMatchObject({ kind: 'upNext', thenListName: null });
    });

    it("from a preview, the end card goes back to the queue's Now and names it", () => {
      const lastOnList = item('c');
      const preview = { ...lastOnList, uuid: 'preview-c' };
      const { result } = renderHook(() =>
        usePlayNavigationModel({
          ...inputs(queue),
          drawerPreviewItem: preview,
          drawerPreviewSuggestionSource: results,
          displayedQueueItem: preview,
          displayedClimb: preview.climb,
        }),
      );
      expect(result.current.trackEndCard).toEqual({
        listName: 'Search results',
        upNextCount: 2,
        firstUpNextName: null,
        backToName: 'Climb a',
        action: { kind: 'backToCommitted' },
      });
    });
  });

  // The then-signposts: the model reads where each step lands off the walk's
  // own steps, so the top bar, the tick and the event never guess.
  describe('the then-signposts', () => {
    const onList = item('a');
    const queuedFirst = item('q1');
    const queuedSecond = item('q2');
    const queue = [onList, queuedFirst, queuedSecond];
    const projects: PlaylistSuggestionSource = {
      playlistUuid: 'smart:projects',
      activatedClimbUuid: 'a',
      boardKey: 'kilter:1',
      climbs: [onList.climb, item('b').climb, item('c').climb],
      label: 'Projects',
      total: 3,
    };
    const walking: PlaylistSuggestionSource = { ...projects, resume: { climbUuid: 'a', queueItemUuid: onList.uuid } };
    function own(displayed: ClimbQueueItem, source: PlaylistSuggestionSource) {
      return {
        ...inputs(queue),
        displayedQueueItem: displayed,
        displayedClimb: displayed.climb,
        currentClimbQueueItem: displayed,
        playlistSuggestionSource: source,
      };
    }

    it('on your own climb, Next steps into Up next and counts it', () => {
      const { result } = renderHook(() => usePlayNavigationModel(own(onList, projects)));
      expect(result.current.signposts).toEqual({
        upNextCount: 2,
        nextTrack: 'upNext',
        previousTrack: 'list',
        nextCrosses: false,
        previousCrosses: false,
        upNextFirstCount: 2,
      });
    });

    it('the last Up next climb crosses onto the list; the first crosses back', () => {
      const last = renderHook(() => usePlayNavigationModel(own(queuedSecond, walking)));
      expect(last.result.current.signposts).toMatchObject({
        nextTrack: 'list',
        nextCrosses: true,
        upNextFirstCount: null,
      });
      const first = renderHook(() => usePlayNavigationModel(own(queuedFirst, walking)));
      expect(first.result.current.signposts).toMatchObject({
        nextTrack: 'upNext',
        nextCrosses: false,
        previousTrack: 'list',
        previousCrosses: true,
      });
    });

    it('with Up next empty, nothing is new: no count, no crossing, no "then"', () => {
      const alone = [onList];
      const { result } = renderHook(() => usePlayNavigationModel({ ...own(onList, projects), queue: alone }));
      expect(result.current.signposts).toEqual({
        upNextCount: 0,
        nextTrack: 'list',
        previousTrack: 'list',
        nextCrosses: false,
        previousCrosses: false,
        upNextFirstCount: null,
      });
    });

    // #5099: a queued climb this wall can't draw is walked past, so it never
    // counts and never takes the "then" off the climb before it.
    it('passes over a queued climb this wall cannot draw', () => {
      const otherBoard = item('x', 'pxr12', 'tension', 9);
      const mixed = [onList, queuedFirst, otherBoard];
      const fromList = renderHook(() => usePlayNavigationModel({ ...own(onList, projects), queue: mixed }));
      expect(fromList.result.current.signposts.upNextFirstCount).toBe(1);
      const onQueued = renderHook(() => usePlayNavigationModel({ ...own(queuedFirst, walking), queue: mixed }));
      expect(onQueued.result.current.currentTrackLabel).toEqual({
        kind: 'upNext',
        listName: 'Projects',
        count: { position: 1, total: 1 },
        thenListName: 'Projects',
      });
      expect(onQueued.result.current.signposts).toMatchObject({ nextTrack: 'list', nextCrosses: true });
      expect(onQueued.result.current.navigationState.nextItem?.climb.uuid).toBe('b');
    });

    // The list's next climb is not loaded yet: "then" still names the list
    // while its next page can load, and only then.
    it('names the list after Up next while its next climb is still to load', () => {
      const firstPageOnly: PlaylistSuggestionSource = {
        ...walking,
        climbs: [onList.climb],
        total: 3,
        continuation: { loaderId: registerTrackPageLoader(async () => null), nextPage: 1 },
      };
      const paging = renderHook(() => usePlayNavigationModel(own(queuedSecond, firstPageOnly)));
      expect(paging.result.current.currentTrackLabel).toMatchObject({ kind: 'upNext', thenListName: 'Projects' });
      // A loader that is gone (restored after a restart) ends the track here.
      const stranded = { ...firstPageOnly, continuation: { loaderId: 'track-pages-gone-1', nextPage: 1 } };
      const ended = renderHook(() => usePlayNavigationModel(own(queuedSecond, stranded)));
      expect(ended.result.current.currentTrackLabel).toMatchObject({ kind: 'upNext', thenListName: null });
    });

    // F3 now-slot mode: with nothing current, History stays in the array and
    // Up next starts at the line, so the note never counts History.
    it('never counts History as Up next with nothing current', () => {
      const played = [item('h1'), item('h2'), item('u1')];
      const nothingCurrent = {
        ...inputs(played),
        currentClimbQueueItem: null,
        historyCount: 2,
        drawerPreviewItem: item('s5'),
        drawerPreviewSuggestionSource: projects,
        displayedQueueItem: item('s5'),
        displayedClimb: item('s5').climb,
      };
      const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps: nothingCurrent });
      expect(result.current.signposts.upNextCount).toBe(1);
      // All of it played: Up next is empty, so no note and no bucket above 0.
      rerender({ ...nothingCurrent, historyCount: 3 });
      expect(result.current.signposts.upNextCount).toBe(0);
    });

    it('keeps the signposts object while nothing about the walk changed', () => {
      const initialProps = own(onList, projects);
      const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps });
      const first = result.current.signposts;
      rerender({ ...initialProps, queue: [...queue] });
      expect(result.current.signposts).toBe(first);
    });
  });

  // #7247, the owner's report on 2.7.0: Now was Debaser, 13 of Search results'
  // 11,312, and Play next put MacroDre, a climb History held from a walk down
  // the same results, at the head of Up next (row 41). The queue sheet listed
  // it; the top bar read "Search results · 13 of 11,312" with no "Up next
  // first" line, and swipes walked the results past it.
  describe('Play next on a climb History holds from the list being walked (#7247)', () => {
    /** The English catalog, pluralised the way i18next does it. */
    const t = ((key: string, values: Record<string, string | number> = {}) => {
      const lookup = (path: string): unknown =>
        path
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enSession);
      const count = values.count;
      const template =
        typeof count === 'number' ? (lookup(`${key}_${count === 1 ? 'one' : 'other'}`) ?? lookup(key)) : lookup(key);
      if (typeof template !== 'string') return key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, field: string) => `${values[field] ?? ''}`);
    }) as unknown as TFunction<'session'>;

    const results = Array.from({ length: 20 }, (_, index) => item(`r${index + 1}`).climb);
    const searchResults: PlaylistSuggestionSource = {
      playlistUuid: 'search',
      activatedClimbUuid: 'r1',
      boardKey: 'kilter:1',
      climbs: results,
      label: 'Search results',
      total: 11312,
    };
    const walked = (uuid: string, climbIndex: number): ClimbQueueItem => ({
      uuid,
      climb: results[climbIndex],
      suggested: true,
    });
    const debaser = walked('now-debaser', 12);

    /** 40 climbs of History, two passes down the results reaching MacroDre (r5), then Play next on it. */
    function ownersQueueAfterPlayNext(historyCountOf: (queue: ClimbQueueItem[]) => number | null) {
      const older = Array.from({ length: 22 }, (_, index) => item(`old-${index}`));
      const firstPass = results.slice(0, 12).map((_, index) => walked(`first-${index}`, index));
      const secondPass = results.slice(4, 10).map((_, index) => walked(`second-${index}`, index + 4));
      const before = [...older, ...firstPass, ...secondPass, debaser];
      const plan = planPlayNext(before, debaser, { climbUuid: 'r5' }, historyCountOf(before));
      if (plan.kind !== 'move') throw new Error(`Play next planned ${plan.kind}`);
      // A move is one reorder, a splice out and back in, and the queue provider
      // drops the list walk's flag by uuid when the plan says so.
      const after = [...before];
      const [moved] = after.splice(plan.oldIndex, 1);
      after.splice(plan.newIndex, 0, plan.dropListWalkFlag ? withoutListWalkFlag(moved) : moved);
      return after;
    }

    it.each([
      { mode: 'now-slot', historyCountOf: (queue: ClimbQueueItem[]) => queue.indexOf(debaser) },
      { mode: 'legacy', historyCountOf: () => null },
    ])('$mode: Next plays MacroDre, and the top bar says "Up next first · 1 climb"', ({ historyCountOf }) => {
      const queue = ownersQueueAfterPlayNext(historyCountOf);
      const macroDre = queue[queue.indexOf(debaser) + 1];
      expect(macroDre.climb.uuid).toBe('r5');
      expect(queue.indexOf(macroDre)).toBe(40);
      expect(queue.slice(0, 40).some((queued) => queued.climb.uuid === 'r5')).toBe(true);

      const { result } = renderHook(() =>
        usePlayNavigationModel({
          ...inputs(queue),
          displayedQueueItem: debaser,
          displayedClimb: debaser.climb,
          currentClimbQueueItem: debaser,
          historyCount: historyCountOf(queue),
          playlistSuggestionSource: searchResults,
        }),
      );
      expect(result.current.navigationState.nextItem).toBe(macroDre);
      expect(result.current.nextHeaderClimb?.uuid).toBe('r5');
      expect(result.current.currentTrackLabel).toEqual({
        kind: 'counted',
        name: 'Search results',
        position: 13,
        total: 11312,
      });
      expect(result.current.signposts).toEqual({
        upNextCount: 1,
        nextTrack: 'upNext',
        previousTrack: 'list',
        nextCrosses: false,
        previousCrosses: false,
        upNextFirstCount: 1,
      });
      expect(
        resolveUpNextFirstCaption({
          enabled: true,
          isPreview: false,
          trackLabel: result.current.currentTrackLabel,
          upNextFirstCount: result.current.signposts.upNextFirstCount,
          t,
        }),
      ).toBe('Up next first · 1 climb');
    });
  });
});
