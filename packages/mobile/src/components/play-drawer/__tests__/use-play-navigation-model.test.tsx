// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getBoardConfigForPlaylist } from '../../../lib/playlists/board-details-for-playlist';
import type { BoardConfig } from '../play-drawer-types';
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

    it('says "Up next · 1 of 2" while a queued climb plays, and comes back to the list after', () => {
      const { result, rerender } = renderHook(usePlayNavigationModel, { initialProps: playingUpNext(queuedFirst) });
      expect(result.current.currentTrackLabel).toEqual({
        kind: 'upNext',
        listName: 'Search results',
        count: { position: 1, total: 2 },
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
        action: null,
      });
    });
  });
});
