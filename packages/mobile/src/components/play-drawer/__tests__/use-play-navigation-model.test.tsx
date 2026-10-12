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
});
