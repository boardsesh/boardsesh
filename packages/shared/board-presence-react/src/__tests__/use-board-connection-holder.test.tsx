import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardConnectionHolder, BoardPresenceEvent } from '@boardsesh/shared-schema';
import { useBoardConnectionHolder, type BoardConnectionHolderClient } from '../use-board-connection-holder';

const CREW_HOLDER: BoardConnectionHolder = { userId: 'crew-holder', displayName: 'Crewmate' };
const BOARD_UUID = '11111111-1111-4111-8111-111111111111';

function deferred<T>() {
  let resolve: (result: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeHarness(initialHolder: BoardConnectionHolder | null = null) {
  const streams: Array<{
    boardId: number;
    boardUuid: string | null | undefined;
    onEvent: (event: BoardPresenceEvent) => void;
    onError?: (error: unknown) => void;
    onComplete?: () => void;
    unsubscribe: () => void;
  }> = [];
  const invalidationListeners = new Set<() => void>();
  const reconnectListeners = new Set<() => void>();
  const fetchConnection = vi.fn<NonNullable<BoardConnectionHolderClient['fetchConnection']>>(async () => initialHolder);
  const subscribeNowPlaying = vi.fn<BoardConnectionHolderClient['subscribeNowPlaying']>(
    (boardId, onEvent, onError, onComplete, boardUuid) => {
      const unsubscribe = vi.fn();
      streams.push({ boardId, boardUuid, onEvent, onError, onComplete, unsubscribe });
      return unsubscribe;
    },
  );
  const client: BoardConnectionHolderClient = {
    subscribeNowPlaying,
    fetchConnection,
    onReconnect: (listener) => {
      reconnectListeners.add(listener);
      return () => {
        reconnectListeners.delete(listener);
      };
    },
  };
  const options = {
    boardId: 7,
    boardUuid: BOARD_UUID,
    client,
    enabled: true,
    subscribeInvalidation: (listener: () => void) => {
      invalidationListeners.add(listener);
      return () => {
        invalidationListeners.delete(listener);
      };
    },
  };
  return {
    options,
    streams,
    fetchConnection,
    subscribeNowPlaying,
    invalidationListeners,
    reconnectListeners,
    publish: (holder: BoardConnectionHolder | null, seq: number, streamIndex = streams.length - 1) => {
      act(() => {
        streams[streamIndex].onEvent({ __typename: 'BoardConnectionChanged', holder, seq });
      });
    },
    close: () =>
      act(() => {
        for (const listener of invalidationListeners) listener();
      }),
    reconnect: () =>
      act(() => {
        for (const listener of reconnectListeners) listener();
      }),
    publishStats: (seq: number) =>
      act(() => {
        streams.at(-1)?.onEvent({
          __typename: 'BoardStatsUpdated',
          seq,
          stats: { climbsSentCount: 0, distinctClimbersCount: 0, hardestGrade: null, topGrade: null, lastSentAt: null },
        });
      }),
  };
}

const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useBoardConnectionHolder', () => {
  it('confirms a holder with one scoped snapshot and no history or stats requests', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    await flush();
    expect(result.current).toMatchObject({ holder: CREW_HOLDER, confirmed: true });
    expect(harness.fetchConnection).toHaveBeenCalledExactlyOnceWith(7, BOARD_UUID);
    expect(harness.streams[0]).toMatchObject({ boardId: 7, boardUuid: BOARD_UUID });
  });

  it('does not let a pending snapshot or its rejection overwrite a newer release', async () => {
    const harness = makeHarness();
    const firstRead = deferred<BoardConnectionHolder | null>();
    harness.fetchConnection.mockReturnValueOnce(firstRead.promise);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    harness.publish(CREW_HOLDER, 1);
    harness.publish(null, 2);
    firstRead.reject(new Error('Old snapshot failed'));
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.streams[0].unsubscribe).not.toHaveBeenCalled();
  });

  it('drops a late holder snapshot after a newer release, even with unrelated stats events', async () => {
    const harness = makeHarness();
    const firstRead = deferred<BoardConnectionHolder | null>();
    harness.fetchConnection.mockReturnValueOnce(firstRead.promise);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    harness.publish(null, 12);
    act(() => {
      harness.streams[0].onEvent({ __typename: 'BoardHistoryUpdated', climbs: [], seq: 90 });
    });
    firstRead.resolve(CREW_HOLDER);
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
  });

  it('ignores stale holder events', () => {
    const harness = makeHarness();
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    harness.publish(CREW_HOLDER, 1);
    harness.publish(null, 2);
    harness.publish(CREW_HOLDER, 1);
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
  });

  it('invalidates on close and stays unconfirmed during a deferred retry snapshot', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const retryRead = deferred<BoardConnectionHolder | null>();
    harness.fetchConnection.mockResolvedValueOnce(CREW_HOLDER).mockReturnValueOnce(retryRead.promise);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    await flush();
    expect(result.current.confirmed).toBe(true);
    harness.close();
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    expect(harness.streams[0].unsubscribe).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(harness.subscribeNowPlaying).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    retryRead.resolve(CREW_HOLDER);
    await flush();
    expect(result.current).toMatchObject({ holder: CREW_HOLDER, confirmed: true });
  });

  it('does not restore a cached holder after a rejected retry snapshot, and backs off once', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const retryRead = deferred<BoardConnectionHolder | null>();
    harness.fetchConnection.mockResolvedValueOnce(CREW_HOLDER).mockReturnValueOnce(retryRead.promise);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    await flush();
    harness.close();
    harness.close();
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    retryRead.reject(new Error('Retry snapshot failed'));
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(harness.fetchConnection).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(harness.fetchConnection).toHaveBeenCalledTimes(3);
    expect(result.current.confirmed).toBe(true);
  });

  it('requires fresh confirmation after reconnect, not merely a reattached subscription', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const reconnectRead = deferred<BoardConnectionHolder | null>();
    harness.fetchConnection.mockResolvedValueOnce(CREW_HOLDER).mockReturnValueOnce(reconnectRead.promise);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    await flush();
    harness.reconnect();
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    reconnectRead.resolve(null);
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
  });

  it('drops ownership immediately while disabled and rereads on foreground enable', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const { result, rerender } = renderHook(
      ({ enabled }) => useBoardConnectionHolder({ ...harness.options, enabled }),
      {
        initialProps: { enabled: true },
      },
    );
    await flush();
    rerender({ enabled: false });
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    expect(harness.streams[0].unsubscribe).toHaveBeenCalledOnce();
    harness.fetchConnection.mockResolvedValue(null);
    rerender({ enabled: true });
    expect(result.current.confirmed).toBe(false);
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
    expect(harness.fetchConnection).toHaveBeenCalledTimes(2);
  });

  it('never shows a prior board’s delayed snapshot or events after a scope change', async () => {
    const harness = makeHarness();
    const firstRead = deferred<BoardConnectionHolder | null>();
    harness.fetchConnection.mockReturnValueOnce(firstRead.promise);
    const { result, rerender } = renderHook(
      ({ boardId }) => useBoardConnectionHolder({ ...harness.options, boardId }),
      {
        initialProps: { boardId: 7 },
      },
    );
    harness.publish(CREW_HOLDER, 1);
    rerender({ boardId: 8 });
    expect(result.current.confirmed).toBe(false);
    harness.publish(CREW_HOLDER, 2, 0);
    firstRead.resolve(CREW_HOLDER);
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
    expect(harness.fetchConnection).toHaveBeenLastCalledWith(8, BOARD_UUID);
  });

  it.each(['error', 'complete', 'throw'] as const)('cleans up a synchronous subscribe %s', (outcome) => {
    const harness = makeHarness();
    const release = vi.fn();
    harness.subscribeNowPlaying.mockImplementationOnce((_boardId, _onEvent, onError, onComplete) => {
      if (outcome === 'throw') throw new Error('Synchronous transport failure');
      if (outcome === 'error') onError?.(new Error('Synchronous transport failure'));
      else onComplete?.();
      return release;
    });
    const { result, unmount } = renderHook(() => useBoardConnectionHolder(harness.options));
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    expect(harness.fetchConnection).not.toHaveBeenCalled();
    if (outcome !== 'throw') expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(outcome === 'complete' ? 0 : 1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires denied readers without a retry loop', () => {
    const harness = makeHarness();
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    harness.publish(CREW_HOLDER, 1);
    act(() => {
      harness.streams[0].onError?.({ extensions: { code: 'NOT_FOUND' } });
    });
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.streams[0].unsubscribe).toHaveBeenCalledOnce();
    expect(harness.invalidationListeners.size).toBe(0);
    expect(harness.reconnectListeners.size).toBe(0);
    harness.close();
    harness.reconnect();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(harness.subscribeNowPlaying).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires completed readers through later socket closes and reconnects', () => {
    const harness = makeHarness();
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    harness.publish(CREW_HOLDER, 1);
    act(() => {
      harness.streams[0].onComplete?.();
    });
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    expect(harness.invalidationListeners.size).toBe(0);
    expect(harness.reconnectListeners.size).toBe(0);
    harness.close();
    harness.reconnect();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(harness.subscribeNowPlaying).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a missed release from a stats gap without refreshing every unrelated event', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    await flush();
    harness.publishStats(10);
    harness.publishStats(11);
    expect(harness.fetchConnection).toHaveBeenCalledOnce();
    harness.fetchConnection.mockResolvedValue(null);
    harness.publishStats(13);
    expect(result.current).toMatchObject({ holder: null, confirmed: false });
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
    expect(harness.fetchConnection).toHaveBeenCalledTimes(2);
    // A holder event itself resolves a gap without another query.
    harness.publish(CREW_HOLDER, 20);
    expect(result.current).toMatchObject({ holder: CREW_HOLDER, confirmed: true });
    expect(harness.fetchConnection).toHaveBeenCalledTimes(2);
  });

  it('folds overlapping gaps into one pending holder read and one follow-up', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const gapRead = deferred<BoardConnectionHolder | null>();
    const followUpRead = deferred<BoardConnectionHolder | null>();
    harness.fetchConnection
      .mockResolvedValueOnce(CREW_HOLDER)
      .mockReturnValueOnce(gapRead.promise)
      .mockReturnValueOnce(followUpRead.promise);
    const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
    await flush();
    harness.publish(CREW_HOLDER, 10);
    harness.publishStats(12);
    harness.publishStats(14);
    harness.publishStats(16);
    expect(harness.fetchConnection).toHaveBeenCalledTimes(2);
    expect(result.current.confirmed).toBe(false);
    gapRead.resolve(CREW_HOLDER);
    await flush();
    expect(harness.fetchConnection).toHaveBeenCalledTimes(3);
    expect(result.current.confirmed).toBe(false);
    followUpRead.resolve(null);
    await flush();
    expect(result.current).toMatchObject({ holder: null, confirmed: true });
    expect(harness.subscribeNowPlaying).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['before', 'after'] as const)(
    'does not resurrect a delayed holder %s the gap snapshot completes',
    async (arrival) => {
      const harness = makeHarness(CREW_HOLDER);
      const gapRead = deferred<BoardConnectionHolder | null>();
      harness.fetchConnection.mockResolvedValueOnce(CREW_HOLDER).mockReturnValueOnce(gapRead.promise);
      const { result } = renderHook(() => useBoardConnectionHolder(harness.options));
      await flush();
      harness.publish(CREW_HOLDER, 8);
      harness.publishStats(13); // A release at12 was missed.
      if (arrival === 'before') {
        harness.publish(CREW_HOLDER, 11);
        expect(result.current.confirmed).toBe(false);
      }
      gapRead.resolve(null);
      await flush();
      if (arrival === 'after') harness.publish(CREW_HOLDER, 11);
      expect(result.current).toMatchObject({ holder: null, confirmed: true });
      expect(harness.fetchConnection).toHaveBeenCalledTimes(2);
    },
  );

  it('removes its one retry timer and lifecycle listeners on unmount', async () => {
    const harness = makeHarness(CREW_HOLDER);
    const { unmount } = renderHook(() => useBoardConnectionHolder(harness.options));
    await flush();
    harness.close();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.invalidationListeners.size).toBe(0);
    expect(harness.reconnectListeners.size).toBe(0);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(harness.subscribeNowPlaying).toHaveBeenCalledOnce();
  });
});
