import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { preparePlaylistClimbs, type Climb, type ClimbQueueItem } from '@boardsesh/queue';
import {
  usePlaylistClimbActivation,
  type ActivationTrackLoad,
  type PlaylistActivationQueueApi,
} from '../use-playlist-climb-activation';

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
    const fetchClimbsForBoard = vi.fn(async (): Promise<ActivationTrackLoad> => ({ climbs }));
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
    const firstRefresh = deferred<ActivationTrackLoad>();
    const secondRefresh = deferred<ActivationTrackLoad>();
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
    firstRefresh.resolve({ climbs });
    await firstRefresh.promise;
    expect(queueApi.refreshPlaylistSuggestionSource).not.toHaveBeenCalled();
    secondRefresh.resolve({ climbs });
    await secondRefresh.promise;
    expect(queueApi.refreshPlaylistSuggestionSource).toHaveBeenCalledWith(
      expect.objectContaining({ activatedClimbUuid: 'b', climbs }),
    );
    unmount();
  });

  it("names the track and carries the first load's count and continuation into the refresh (#6664)", async () => {
    const climbs = [climb('a'), climb('b'), climb('c')];
    const refresh = deferred<ActivationTrackLoad>();
    const queueApi = {
      setCurrentClimb: vi.fn<PlaylistActivationQueueApi['setCurrentClimb']>(async (selected) => ({
        uuid: selected.uuid,
        climb: selected,
      })),
      refreshPlaylistSuggestionSource: vi.fn(),
    };
    const isClimbable = () => true;
    const { result } = renderHook(() =>
      usePlaylistClimbActivation({
        queueApi,
        sourceId: 'track',
        allClimbs: climbs.slice(0, 2),
        resolveTarget: () => ({ boardKey: 'board', boardName: 'kilter', angle: 40, isClimbable }),
        fetchClimbsForBoard: () => refresh.promise,
        label: 'Projects',
        refreshErrorMessage: 'refresh failed',
      }),
    );
    await result.current(climbs[1]);
    // The first frame already names the list, without a count it cannot vouch for.
    const seeded = queueApi.setCurrentClimb.mock.calls[0]?.[1].playlistSuggestionSource;
    expect(seeded).toMatchObject({ label: 'Projects' });
    expect(seeded).not.toHaveProperty('total');

    refresh.resolve({ climbs, total: 3, continuation: { loaderId: 'loader-1', nextPage: 1 } });
    await refresh.promise;
    await Promise.resolve();
    expect(queueApi.refreshPlaylistSuggestionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Projects',
        total: 3,
        continuation: { loaderId: 'loader-1', nextPage: 1 },
      }),
    );
  });

  describe('a first track that says the rest of the list is still loading (#6664)', () => {
    const climbs = [climb('a'), climb('b'), climb('c')];
    const isClimbable = () => true;

    function renderWithPending(
      queueApi: PlaylistActivationQueueApi,
      fetchClimbsForBoard: () => Promise<ActivationTrackLoad>,
    ) {
      const settled: Array<Promise<boolean>> = [];
      const pendingContinuation = (refreshSettled: Promise<boolean>) => {
        settled.push(refreshSettled);
        return { loaderId: 'pending-1', nextPage: 0 };
      };
      const { result } = renderHook(() =>
        usePlaylistClimbActivation({
          queueApi,
          sourceId: 'track',
          allClimbs: climbs.slice(0, 2),
          resolveTarget: () => ({ boardKey: 'board', boardName: 'kilter', angle: 40, isClimbable }),
          fetchClimbsForBoard,
          pendingContinuation,
          refreshErrorMessage: 'refresh failed',
        }),
      );
      return { activate: result.current, settled };
    }

    // `accepts`: whether the provider takes the fuller track. It ignores one
    // whose track was re-anchored on another climb meanwhile.
    function committingQueueApi({ accepts = true }: { accepts?: boolean } = {}) {
      return {
        setCurrentClimb: vi.fn<PlaylistActivationQueueApi['setCurrentClimb']>(async (selected) => ({
          uuid: selected.uuid,
          climb: selected,
        })),
        refreshPlaylistSuggestionSource: vi.fn<PlaylistActivationQueueApi['refreshPlaylistSuggestionSource']>(
          () => accepts,
        ),
      };
    }

    it('marks the first track and settles true once the fuller track is in place', async () => {
      const queueApi = committingQueueApi();
      const refresh = deferred<ActivationTrackLoad>();
      const { activate, settled } = renderWithPending(queueApi, () => refresh.promise);

      await activate(climbs[1]);
      expect(queueApi.setCurrentClimb.mock.calls[0]?.[1].playlistSuggestionSource?.continuation).toEqual({
        loaderId: 'pending-1',
        nextPage: 0,
      });
      refresh.resolve({ climbs });
      await expect(settled[0]).resolves.toBe(true);
      const fuller = queueApi.refreshPlaylistSuggestionSource.mock.calls[0]?.[0];
      expect(fuller?.climbs.map(({ uuid }: Climb) => uuid)).toEqual(['a', 'b', 'c']);
      // The fuller track is the whole list: it is not waiting on anything.
      expect(queueApi.refreshPlaylistSuggestionSource.mock.calls[0]?.[0]).not.toHaveProperty('continuation');
    });

    it('settles false when the provider ignores the fuller track, so the surviving track can end', async () => {
      // A queue-sheet tap re-anchored the track on another climb before this
      // refresh landed. That track keeps this pending continuation, so settling
      // true would leave it waiting forever, with Next dead and no end card.
      const queueApi = committingQueueApi({ accepts: false });
      const refresh = deferred<ActivationTrackLoad>();
      const { activate, settled } = renderWithPending(queueApi, () => refresh.promise);

      await activate(climbs[1]);
      refresh.resolve({ climbs });
      await expect(settled[0]).resolves.toBe(false);
    });

    it('settles false when the refresh fails, so the first track can end', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const queueApi = committingQueueApi();
      const { activate, settled } = renderWithPending(queueApi, () => Promise.reject(new Error('offline')));

      await activate(climbs[1]);
      await expect(settled[0]).resolves.toBe(false);
      expect(queueApi.refreshPlaylistSuggestionSource).not.toHaveBeenCalled();
    });

    it('settles false when the activation never committed', async () => {
      const queueApi = {
        setCurrentClimb: vi.fn<PlaylistActivationQueueApi['setCurrentClimb']>(async () => null),
        refreshPlaylistSuggestionSource: vi.fn(),
      };
      const fetchClimbsForBoard = vi.fn(async (): Promise<ActivationTrackLoad> => ({ climbs }));
      const { activate, settled } = renderWithPending(queueApi, fetchClimbsForBoard);

      await activate(climbs[1]);
      await expect(settled[0]).resolves.toBe(false);
      expect(fetchClimbsForBoard).not.toHaveBeenCalled();
    });

    it('settles false when the commit throws', async () => {
      const queueApi = {
        setCurrentClimb: vi.fn<PlaylistActivationQueueApi['setCurrentClimb']>(async () => {
          throw new Error('rejected');
        }),
        refreshPlaylistSuggestionSource: vi.fn(),
      };
      const { activate, settled } = renderWithPending(queueApi, async () => ({ climbs }));

      await expect(activate(climbs[1])).rejects.toThrow('rejected');
      await expect(settled[0]).resolves.toBe(false);
    });
  });
});
