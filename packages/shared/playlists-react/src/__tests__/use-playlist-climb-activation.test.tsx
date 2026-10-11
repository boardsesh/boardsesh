import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { preparePlaylistClimbs, type Climb, type ClimbQueueItem } from '@boardsesh/queue';
import { usePlaylistClimbActivation, type PlaylistActivationQueueApi } from '../use-playlist-climb-activation';

function climb(uuid: string): Climb {
  return { uuid, name: uuid } as Climb;
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('prepared climb activation', () => {
  it('reuses prepared ordering but waits for an authorized commit before opening or refreshing', async () => {
    const climbs = [climb('a'), climb('b')];
    const isClimbable = vi.fn(() => true);
    const preparedClimbs = preparePlaylistClimbs(climbs, isClimbable);
    const commit = deferred<ClimbQueueItem | null>();
    const queueApi = {
      setCurrentClimb: vi.fn<PlaylistActivationQueueApi['setCurrentClimb']>(() => commit.promise),
      refreshPlaylistSuggestionSource: vi.fn(),
    };
    const onActivated = vi.fn();
    const fetchClimbsForBoard = vi.fn(async () => climbs);
    const { result } = renderHook(() =>
      usePlaylistClimbActivation({
        queueApi,
        sourceId: 'track',
        allClimbs: climbs,
        preparedClimbs,
        resolveTarget: () => ({ boardKey: 'board', boardName: 'kilter', angle: 40, isClimbable }),
        fetchClimbsForBoard,
        onActivated,
        refreshErrorMessage: 'refresh failed',
      }),
    );
    const activation = result.current(climbs[0]);
    expect(queueApi.setCurrentClimb.mock.calls[0][1].playlistSuggestionSource?.climbs).toBe(preparedClimbs.climbs);
    expect(isClimbable).toHaveBeenCalledTimes(2);
    expect(onActivated).not.toHaveBeenCalled();
    expect(fetchClimbsForBoard).not.toHaveBeenCalled();
    commit.resolve(null);
    await activation;
    expect(onActivated).not.toHaveBeenCalled();
    expect(fetchClimbsForBoard).not.toHaveBeenCalled();
  });

  it('aborts the previous successful refresh after a new authorized activation and ignores its result', async () => {
    const climbs = [climb('a'), climb('b')];
    const firstRefresh = deferred<Climb[]>();
    const secondRefresh = deferred<Climb[]>();
    const fetchClimbsForBoard = vi
      .fn()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const queueApi = {
      setCurrentClimb: vi.fn(async (selected: Climb) => ({ uuid: selected.uuid, climb: selected })),
      refreshPlaylistSuggestionSource: vi.fn(),
    };
    const isClimbable = () => true;
    const { result, unmount } = renderHook(() =>
      usePlaylistClimbActivation({
        queueApi,
        sourceId: 'track',
        allClimbs: climbs,
        preparedClimbs: preparePlaylistClimbs(climbs, isClimbable),
        resolveTarget: () => ({ boardKey: 'board', boardName: 'kilter', angle: 40, isClimbable }),
        fetchClimbsForBoard,
        refreshErrorMessage: 'refresh failed',
      }),
    );
    await result.current(climbs[0]);
    await result.current(climbs[1]);
    expect(fetchClimbsForBoard.mock.calls[0][0].signal.aborted).toBe(true);
    firstRefresh.resolve(climbs);
    await firstRefresh.promise;
    expect(queueApi.refreshPlaylistSuggestionSource).not.toHaveBeenCalled();
    secondRefresh.resolve(climbs);
    await secondRefresh.promise;
    expect(queueApi.refreshPlaylistSuggestionSource).toHaveBeenCalledWith(
      expect.objectContaining({ activatedClimbUuid: 'b', climbs }),
    );
    unmount();
  });
});
