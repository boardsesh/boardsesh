import { act, render, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbStatsForClimbEntry } from '@boardsesh/graphql/operations';
import type { ClimbStatsEvent } from '@boardsesh/shared-schema';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import type { BoardAdapter } from '../adapter';
import {
  acknowledgeOptimisticAscent,
  applyCanonicalClimbStats,
  beginOptimisticAscent,
  getAcknowledgedClimbStatsTokens,
  getClimbStatsSnapshot,
  markOptimisticAscentQueued,
  resetClimbStatsStoreForTests,
  subscribeClimbStats,
  type ClimbStatsKey,
} from '../climb-stats-store';
import {
  createAcknowledgedClimbStatsReadOwner,
  getClimbStatsReadCoordinatorStateForTests,
  MAX_LAST_READ_ENTRIES,
  recordClimbStatsReadForTests,
  resetClimbStatsReadCoordinatorForTests,
  scheduleAcknowledgedClimbStatsRead,
  useClimbStatsLayoutSync,
  useEffectiveClimbStats,
} from '../use-effective-climb-stats';
import { createWrapper } from './test-helpers';

function batchRow(
  climbUuid: string,
  ascensionistCount: number,
  syncSeq: string,
): ClimbStatsForClimbEntry & { ascensionistCount: number } {
  return {
    climbUuid,
    angle: 40,
    ascensionistCount,
    qualityAverage: null,
    difficultyAverage: null,
    displayDifficulty: null,
    difficulty: null,
    faUsername: null,
    faAt: null,
    syncSeq,
  };
}

function rateLimitError(retryAfterSeconds: number): GraphQLOperationError {
  return new GraphQLOperationError([
    {
      message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds },
    },
  ]);
}

describe('useEffectiveClimbStats', () => {
  beforeEach(() => {
    resetClimbStatsStoreForTests();
    resetClimbStatsReadCoordinatorForTests();
  });

  it('re-renders only the exact-key selector child when canonical stats arrive', () => {
    const selectorRender = vi.fn();
    const stableSiblingRender = vi.fn();
    const { wrapper: Wrapper } = createWrapper();

    function StatsSelector() {
      selectorRender();
      const stats = useEffectiveClimbStats('kilter', 1, 'climb-1', 40, {
        ascensionistCount: 4,
        qualityAverage: '2.5',
        difficulty: '6a/V3',
      });
      return <span>{stats.ascensionistCount}</span>;
    }

    function StableSibling() {
      stableSiblingRender();
      return <span>thumbnail</span>;
    }

    render(
      <Wrapper>
        <StableSibling />
        <StatsSelector />
      </Wrapper>,
    );
    expect(selectorRender).toHaveBeenCalledTimes(1);
    expect(stableSiblingRender).toHaveBeenCalledTimes(1);

    act(() => {
      applyCanonicalClimbStats({
        boardType: 'kilter',
        layoutId: 1,
        climbUuid: 'climb-1',
        angle: 40,
        ascensionistCount: 5,
        qualityAverage: 3,
        difficultyAverage: 18,
        displayDifficulty: 18,
        difficulty: '6b/V4',
        faUsername: null,
        faAt: null,
        syncSeq: '10',
      });
    });

    expect(selectorRender).toHaveBeenCalledTimes(2);
    expect(stableSiblingRender).toHaveBeenCalledTimes(1);
  });

  it('treats null fields on a canonical snapshot as authoritative clears', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useEffectiveClimbStats('kilter', 1, 'climb-1', 40, {
          ascensionistCount: 4,
          qualityAverage: '4.5',
          difficulty: '6b/V4',
        }),
      { wrapper },
    );

    act(() => {
      applyCanonicalClimbStats({
        boardType: 'kilter',
        layoutId: 1,
        climbUuid: 'climb-1',
        angle: 40,
        ascensionistCount: 5,
        qualityAverage: null,
        difficultyAverage: null,
        displayDifficulty: null,
        difficulty: null,
        faUsername: null,
        faAt: null,
        syncSeq: '10',
      });
    });

    expect(result.current).toEqual({
      ascensionistCount: 5,
      qualityAverage: null,
      difficulty: null,
    });
  });

  it('lets canonical decreases and zero override base rerenders while preserving a pending floor', () => {
    const { wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ baseCount }: { baseCount: number }) =>
        useEffectiveClimbStats('kilter', 1, 'climb-1', 40, { ascensionistCount: baseCount }),
      { wrapper, initialProps: { baseCount: 10 } },
    );

    act(() => {
      applyCanonicalClimbStats({
        boardType: 'kilter',
        layoutId: 1,
        ...batchRow('climb-1', 5, '10'),
      });
    });
    expect(result.current.ascensionistCount).toBe(5);

    rerender({ baseCount: 99 });
    expect(result.current.ascensionistCount).toBe(5);

    act(() => {
      applyCanonicalClimbStats({
        boardType: 'kilter',
        layoutId: 1,
        ...batchRow('climb-1', 0, '11'),
      });
      // An older event cannot resurrect either canonical or base data.
      applyCanonicalClimbStats({
        boardType: 'kilter',
        layoutId: 1,
        ...batchRow('climb-1', 100, '9'),
      });
    });
    expect(result.current.ascensionistCount).toBe(0);

    act(() => {
      beginOptimisticAscent({ boardType: 'kilter', layoutId: 1, climbUuid: 'climb-1', angle: 40 }, 'pending', 0, 0);
    });
    expect(result.current.ascensionistCount).toBe(1);
  });

  it('dedupes identical UUID selectors inside one microtask batch', async () => {
    const fetchClimbStatsForClimbs = vi.fn().mockResolvedValue([]);
    const { wrapper } = createWrapper({ fetchClimbStatsForClimbs });

    renderHook(
      () => {
        useEffectiveClimbStats('kilter', 1, 'climb-1', 40, { ascensionistCount: 0 });
        useEffectiveClimbStats('kilter', 1, 'climb-1', 45, { ascensionistCount: 0 });
      },
      { wrapper },
    );

    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1));
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledWith('kilter', ['climb-1']);
  });

  it('routes flat rows by UUID and cooldowns requested UUIDs with no rows', async () => {
    const fetchClimbStatsForClimbs = vi.fn().mockResolvedValue([batchRow('climb-b', 7, '1')]);
    const { wrapper } = createWrapper({ fetchClimbStatsForClimbs });
    const first = renderHook(
      () => ({
        empty: useEffectiveClimbStats('kilter', 1, 'climb-a', 40, { ascensionistCount: 2 }),
        populated: useEffectiveClimbStats('kilter', 1, 'climb-b', 40, { ascensionistCount: 3 }),
      }),
      { wrapper },
    );

    await waitFor(() => expect(first.result.current.populated.ascensionistCount).toBe(7));
    expect(first.result.current.empty.ascensionistCount).toBe(2);
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledWith('kilter', ['climb-a', 'climb-b']);
    first.unmount();

    const second = renderHook(() => useEffectiveClimbStats('kilter', 1, 'climb-a', 40, { ascensionistCount: 2 }), {
      wrapper,
    });
    await act(async () => Promise.resolve());
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it('chunks 60 coalesced mount reads into one 50-key flight followed by 10', async () => {
    const pendingBatches: Array<() => void> = [];
    const fetchClimbStats = vi.fn(
      (_boardType: string, _climbUuids: string[]) =>
        new Promise<[]>((resolve) => {
          pendingBatches.push(() => resolve([]));
        }),
    );
    const { wrapper: Wrapper } = createWrapper({ fetchClimbStatsForClimbs: fetchClimbStats });
    const climbUuids = Array.from({ length: 60 }, (_, index) => `climb-${index + 1}`);

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }

    const view = render(
      <Wrapper>
        {climbUuids.map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
      </Wrapper>,
    );

    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(1));
    expect(fetchClimbStats.mock.calls[0]?.[1]).toHaveLength(50);
    expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 1, queued: 10 });

    await act(async () => pendingBatches[0]?.());
    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(2));
    expect(fetchClimbStats.mock.calls[1]?.[1]).toHaveLength(10);
    await act(async () => pendingBatches[1]?.());
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().active).toBe(0));
    view.unmount();
  });

  it('omits queued UUIDs that unmount before the active batch settles', async () => {
    let resolveFirstBatch = () => {};
    const fetchClimbStats = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveFirstBatch = () => resolve([]);
        }),
    );
    const { wrapper: Wrapper } = createWrapper({ fetchClimbStatsForClimbs: fetchClimbStats });
    const climbUuids = Array.from({ length: 60 }, (_, index) => `climb-${index + 1}`);

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }

    const view = render(
      <Wrapper>
        {climbUuids.map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
      </Wrapper>,
    );

    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(1));
    expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 1, queued: 10 });

    view.rerender(
      <Wrapper>
        {climbUuids.slice(0, 50).map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
      </Wrapper>,
    );
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().queued).toBe(0));

    await act(async () => {
      resolveFirstBatch();
    });
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().active).toBe(0));
    expect(fetchClimbStats).toHaveBeenCalledTimes(1);
  });

  it('TTL-prunes and LRU-bounds read timestamps', () => {
    const startingTime = 1_000_000;
    for (let index = 0; index <= MAX_LAST_READ_ENTRIES; index += 1) {
      recordClimbStatsReadForTests(`climb-${index}`, startingTime + index);
    }
    expect(getClimbStatsReadCoordinatorStateForTests().timestamps).toBe(MAX_LAST_READ_ENTRIES);

    resetClimbStatsReadCoordinatorForTests();
    recordClimbStatsReadForTests('stale', startingTime);
    recordClimbStatsReadForTests('fresh', startingTime + 11 * 60_000);
    expect(getClimbStatsReadCoordinatorStateForTests().timestamps).toBe(1);
  });

  it('dedupes mount reads and performs bounded repair on reconnect and the missed-event timer', async () => {
    const fetchClimbStats = vi.fn().mockResolvedValue([
      {
        climbUuid: 'climb-1',
        angle: 40,
        ascensionistCount: 5,
        qualityAverage: 3,
        difficultyAverage: 18,
        displayDifficulty: 18,
        difficulty: '6b/V4',
        faUsername: null,
        faAt: null,
        syncSeq: '10',
      },
    ]);
    let connected: (() => void) | undefined;
    const scheduledTasks: Array<{ callback: () => void; cancel: ReturnType<typeof vi.fn>; delayMs: number }> = [];
    const { wrapper } = createWrapper({
      fetchClimbStatsForClimbs: fetchClimbStats,
      subscribeClimbStats: (_boardType, _layoutId, handlers) => {
        connected = handlers.connected;
        return vi.fn();
      },
      scheduleTask: (callback, delayMs) => {
        const cancel = vi.fn();
        scheduledTasks.push({ callback, cancel, delayMs });
        return cancel;
      },
    });

    const view = renderHook(
      () => {
        useClimbStatsLayoutSync('kilter', 1);
        return useEffectiveClimbStats('kilter', 1, 'climb-1', 40, { ascensionistCount: 4 });
      },
      { wrapper },
    );
    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(1));

    act(() => connected?.());
    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(2));

    const missedEventRepair = scheduledTasks[0]?.callback;
    expect(missedEventRepair).toBeTypeOf('function');
    expect(scheduledTasks[0]?.delayMs).toBe(120_000);
    act(() => missedEventRepair?.());
    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(3));
    expect(scheduledTasks).toHaveLength(2);

    view.unmount();
    expect(scheduledTasks[1]?.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a canceled board-switch post-ack obligation for the next successful primary read', async () => {
    const fetchClimbStats = vi.fn().mockResolvedValue([batchRow('climb-1', 10, '1')]);
    let deliveryListener:
      | ((event: {
          tableName: string;
          operation: string;
          idempotencyKey: string;
          status: 'acknowledged' | 'dead_letter';
        }) => void)
      | undefined;
    const unsubscribeDelivery = vi.fn();
    const scheduledTasks: Array<{ callback: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
    const { wrapper } = createWrapper({
      fetchClimbStatsForClimbs: fetchClimbStats,
      subscribeOfflineMutationDelivery: (listener) => {
        deliveryListener = listener;
        return unsubscribeDelivery;
      },
      scheduleTask: (callback) => {
        const cancel = vi.fn();
        scheduledTasks.push({ callback, cancel });
        return cancel;
      },
    });
    const statsKey: ClimbStatsKey = {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'climb-1',
      angle: 40,
    };
    beginOptimisticAscent(statsKey, 'token-1', 0, 10);
    markOptimisticAscentQueued('token-1', 'tick-1', 0);

    const view = renderHook(() => useClimbStatsLayoutSync(null, undefined), { wrapper });
    act(() => {
      deliveryListener?.({
        tableName: 'boardsesh_ticks',
        operation: 'create',
        idempotencyKey: 'tick-1',
        status: 'acknowledged',
      });
    });
    expect(scheduledTasks).toHaveLength(1);

    view.unmount();
    expect(unsubscribeDelivery).toHaveBeenCalledTimes(1);
    expect(scheduledTasks[0]?.cancel).toHaveBeenCalledTimes(1);

    act(() => scheduledTasks[0]?.callback());
    expect(fetchClimbStats).not.toHaveBeenCalled();

    const repaired = renderHook(() => useEffectiveClimbStats('kilter', 1, 'climb-1', 40, { ascensionistCount: 10 }), {
      wrapper,
    });
    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getClimbStatsSnapshot(statsKey).optimisticFloor).toBeNull());
    expect(repaired.result.current.ascensionistCount).toBe(10);
    repaired.unmount();
  });

  it('cancels every pending post-ack read owned by one lifecycle', () => {
    const cancelTasks = [vi.fn(), vi.fn()];
    const adapter: BoardAdapter = {
      isAuthenticated: true,
      isAuthLoading: false,
      executeHttp: async () => {
        throw new Error('not used');
      },
      executeWs: async () => {
        throw new Error('not used');
      },
      resolveActiveSessionId: () => undefined,
      scheduleTask: vi.fn().mockReturnValueOnce(cancelTasks[0]).mockReturnValueOnce(cancelTasks[1]),
    };
    const owner = createAcknowledgedClimbStatsReadOwner();
    owner.schedule(adapter, { boardType: 'kilter', layoutId: 1, climbUuid: 'climb-1', angle: 40 });
    owner.schedule(adapter, { boardType: 'kilter', layoutId: 1, climbUuid: 'climb-2', angle: 40 });

    owner.cancelAll();

    expect(cancelTasks[0]).toHaveBeenCalledTimes(1);
    expect(cancelTasks[1]).toHaveBeenCalledTimes(1);
  });

  it('keeps a terminally failed post-ack obligation for a later successful read', async () => {
    const statsKey: ClimbStatsKey = {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'climb-terminal',
      angle: 40,
    };
    const fetchClimbStatsForClimbs = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([batchRow('climb-terminal', 3, '1')]);
    const { wrapper, adapter } = createWrapper({ fetchClimbStatsForClimbs });
    beginOptimisticAscent(statsKey, 'terminal-token', 0, 10);
    acknowledgeOptimisticAscent('terminal-token', 0);

    scheduleAcknowledgedClimbStatsRead(adapter, statsKey, undefined, 'terminal-token');
    await waitFor(() => {
      expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);
      expect(getClimbStatsReadCoordinatorStateForTests().active).toBe(0);
    });
    expect(getAcknowledgedClimbStatsTokens('kilter', 'climb-terminal', 0)).toEqual(['terminal-token']);
    expect(getClimbStatsSnapshot(statsKey).optimisticFloor).toBe(11);

    const repaired = renderHook(
      () => useEffectiveClimbStats('kilter', 1, 'climb-terminal', 40, { ascensionistCount: 3 }),
      { wrapper },
    );
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getClimbStatsSnapshot(statsKey).optimisticFloor).toBeNull());
    expect(repaired.result.current.ascensionistCount).toBe(3);
    repaired.unmount();
  });

  it('does not retain a cancellation handle when the scheduler runs synchronously', async () => {
    const statsKey: ClimbStatsKey = {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'climb-sync',
      angle: 40,
    };
    const unsubscribe = subscribeClimbStats(statsKey, vi.fn());
    const cancelTask = vi.fn();
    const fetchClimbStats = vi.fn().mockResolvedValue([]);
    const owner = createAcknowledgedClimbStatsReadOwner();
    owner.schedule(
      {
        isAuthenticated: true,
        isAuthLoading: false,
        executeHttp: async () => {
          throw new Error('not used');
        },
        executeWs: async () => {
          throw new Error('not used');
        },
        resolveActiveSessionId: () => undefined,
        fetchClimbStatsForClimbs: fetchClimbStats,
        scheduleTask: (callback) => {
          callback();
          return cancelTask;
        },
      },
      statsKey,
    );

    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(1));
    owner.cancelAll();
    expect(cancelTask).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('starts one forced post-ack read after a stale in-flight read settles', async () => {
    const pendingReads: Array<
      (
        rows: Array<{
          climbUuid: string;
          angle: number;
          ascensionistCount: number;
          qualityAverage: number | null;
          difficultyAverage: number | null;
          displayDifficulty: number | null;
          difficulty: string | null;
          faUsername: string | null;
          faAt: string | null;
          syncSeq: string;
        }>,
      ) => void
    > = [];
    const fetchClimbStats = vi.fn(
      () =>
        new Promise<Parameters<(typeof pendingReads)[number]>[0]>((resolve) => {
          pendingReads.push(resolve);
        }),
    );
    const scheduledTasks: Array<() => void> = [];
    const adapterOverrides = {
      fetchClimbStatsForClimbs: fetchClimbStats,
      scheduleTask: (callback: () => void) => {
        scheduledTasks.push(callback);
        return vi.fn();
      },
    };
    const { wrapper } = createWrapper(adapterOverrides);
    const statsKey: ClimbStatsKey = {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'climb-1',
      angle: 40,
    };
    const { result } = renderHook(() => useEffectiveClimbStats('kilter', 1, 'climb-1', 40, { ascensionistCount: 10 }), {
      wrapper,
    });
    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(1));

    act(() => {
      beginOptimisticAscent(statsKey, 'token-1', 0, 10);
      acknowledgeOptimisticAscent('token-1', 0);
      scheduleAcknowledgedClimbStatsRead(
        {
          isAuthenticated: true,
          isAuthLoading: false,
          executeHttp: async () => {
            throw new Error('not used');
          },
          executeWs: async () => {
            throw new Error('not used');
          },
          resolveActiveSessionId: () => undefined,
          ...adapterOverrides,
        },
        statsKey,
        undefined,
        'token-1',
      );
      scheduledTasks[0]?.();
      scheduledTasks[0]?.();
    });

    expect(fetchClimbStats).toHaveBeenCalledTimes(1);
    expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 1, queued: 1 });
    expect(result.current.ascensionistCount).toBe(11);

    await act(async () => {
      pendingReads[0]?.([
        {
          climbUuid: 'climb-1',
          angle: 40,
          ascensionistCount: 10,
          qualityAverage: null,
          difficultyAverage: null,
          displayDifficulty: null,
          difficulty: null,
          faUsername: null,
          faAt: null,
          syncSeq: '10',
        },
      ]);
    });
    await waitFor(() => expect(fetchClimbStats).toHaveBeenCalledTimes(2));
    expect(result.current.ascensionistCount).toBe(11);
    expect(getClimbStatsSnapshot(statsKey).optimisticFloor).toBe(11);

    await act(async () => {
      pendingReads[1]?.([
        {
          climbUuid: 'climb-1',
          angle: 40,
          ascensionistCount: 11,
          qualityAverage: null,
          difficultyAverage: null,
          displayDifficulty: null,
          difficulty: null,
          faUsername: null,
          faAt: null,
          syncSeq: '11',
        },
      ]);
    });
    await waitFor(() => expect(getClimbStatsSnapshot(statsKey).optimisticFloor).toBeNull());
    expect(fetchClimbStats).toHaveBeenCalledTimes(2);
    expect(result.current.ascensionistCount).toBe(11);
  });

  it('runs a forced follow-up before ordinary UUIDs queued behind the active batch', async () => {
    const pendingBatches: Array<(rows: ClimbStatsForClimbEntry[]) => void> = [];
    const fetchClimbStatsForClimbs = vi.fn(
      (_boardType: string, _climbUuids: string[]) =>
        new Promise<ClimbStatsForClimbEntry[]>((resolve) => {
          pendingBatches.push(resolve);
        }),
    );
    const { wrapper: Wrapper, adapter } = createWrapper({ fetchClimbStatsForClimbs });

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }

    const first = render(
      <Wrapper>
        <StatsRow climbUuid="active" />
      </Wrapper>,
    );
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1));

    first.unmount();
    const queued = render(
      <Wrapper>
        <StatsRow climbUuid="ordinary" />
        <StatsRow climbUuid="forced" />
      </Wrapper>,
    );
    scheduleAcknowledgedClimbStatsRead(
      adapter,
      { boardType: 'kilter', layoutId: 1, climbUuid: 'forced', angle: 40 },
      undefined,
    );

    await act(async () => pendingBatches[0]?.([]));
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2));
    expect(fetchClimbStatsForClimbs.mock.calls[1]?.[1]).toEqual(['forced']);

    await act(async () => pendingBatches[1]?.([]));
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(3));
    expect(fetchClimbStatsForClimbs.mock.calls[2]?.[1]).toEqual(['ordinary']);
    await act(async () => pendingBatches[2]?.([]));
    queued.unmount();
  });

  it('pauses and retries a multi-UUID RATE_LIMITED lane with one timer and one batch', async () => {
    const fetchClimbStatsForClimbs = vi.fn().mockRejectedValueOnce(rateLimitError(2)).mockResolvedValueOnce([]);
    const scheduledTasks: Array<{ callback: () => void; delayMs: number }> = [];
    const { wrapper: Wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      scheduleTask: (callback, delayMs) => {
        scheduledTasks.push({ callback, delayMs });
        return vi.fn();
      },
    });

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }
    const view = render(
      <Wrapper>
        <StatsRow climbUuid="climb-rate-a" />
        <StatsRow climbUuid="climb-rate-b" />
        <StatsRow climbUuid="climb-rate-c" />
      </Wrapper>,
    );
    await waitFor(() => expect(scheduledTasks).toHaveLength(1));
    expect(scheduledTasks[0]?.delayMs).toBe(2_000);
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);
    expect(fetchClimbStatsForClimbs.mock.calls[0]?.[1]).toEqual(['climb-rate-a', 'climb-rate-b', 'climb-rate-c']);

    act(() => scheduledTasks[0]?.callback());
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2));
    expect(fetchClimbStatsForClimbs.mock.calls[1]?.[1]).toEqual(['climb-rate-a', 'climb-rate-b', 'climb-rate-c']);
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().active).toBe(0));
    expect(scheduledTasks).toHaveLength(1);
    view.unmount();
  });

  it('holds later chunks in a 60-UUID lane until one 50-UUID retry succeeds', async () => {
    const fetchClimbStatsForClimbs = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError(4))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const scheduledTasks: Array<{ callback: () => void; delayMs: number }> = [];
    const { wrapper: Wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      scheduleTask: (callback, delayMs) => {
        scheduledTasks.push({ callback, delayMs });
        return vi.fn();
      },
    });
    const climbUuids = Array.from({ length: 60 }, (_, index) => `rate-chunk-${index + 1}`);

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }
    const view = render(
      <Wrapper>
        {climbUuids.map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
      </Wrapper>,
    );

    await waitFor(() => expect(scheduledTasks).toHaveLength(1));
    expect(scheduledTasks[0]?.delayMs).toBe(4_000);
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);
    expect(fetchClimbStatsForClimbs.mock.calls[0]?.[1]).toEqual(climbUuids.slice(0, 50));
    expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 0, queued: 60 });

    act(() => scheduledTasks[0]?.callback());
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(3));
    expect(fetchClimbStatsForClimbs.mock.calls[1]?.[1]).toEqual(climbUuids.slice(0, 50));
    expect(fetchClimbStatsForClimbs.mock.calls[2]?.[1]).toEqual(climbUuids.slice(50));
    expect(scheduledTasks).toHaveLength(1);
    view.unmount();
  });

  it('stops the whole lane after its single retry is rate-limited again', async () => {
    const fetchClimbStatsForClimbs = vi.fn().mockRejectedValue(rateLimitError(2));
    const scheduledTasks: Array<() => void> = [];
    const { wrapper: Wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      scheduleTask: (callback) => {
        scheduledTasks.push(callback);
        return vi.fn();
      },
    });
    const climbUuids = Array.from({ length: 60 }, (_, index) => `rate-stop-${index + 1}`);

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }
    const view = render(
      <Wrapper>
        {climbUuids.map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
      </Wrapper>,
    );

    await waitFor(() => expect(scheduledTasks).toHaveLength(1));
    act(() => scheduledTasks[0]?.());
    await waitFor(() => {
      expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2);
      expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 0, queued: 0 });
    });
    expect(fetchClimbStatsForClimbs.mock.calls[0]?.[1]).toHaveLength(50);
    expect(fetchClimbStatsForClimbs.mock.calls[1]?.[1]).toHaveLength(50);
    expect(scheduledTasks).toHaveLength(1);
    view.unmount();
  });

  it('keeps retry lane ownership when later chunks unmount and same-auth work arrives', async () => {
    let rejectRetry = (_error: unknown) => {};
    const fetchClimbStatsForClimbs = vi
      .fn()
      .mockRejectedValue(rateLimitError(6))
      .mockRejectedValueOnce(rateLimitError(6))
      .mockImplementationOnce(
        () =>
          new Promise<ClimbStatsForClimbEntry[]>((_resolve, reject) => {
            rejectRetry = reject;
          }),
      );
    const scheduledTasks: Array<() => void> = [];
    const { wrapper: Wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      scheduleTask: (callback) => {
        scheduledTasks.push(callback);
        return vi.fn();
      },
    });
    const climbUuids = Array.from({ length: 60 }, (_, index) => `retry-owner-${index + 1}`);

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }
    const view = render(
      <Wrapper>
        {climbUuids.map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
      </Wrapper>,
    );
    await waitFor(() => expect(scheduledTasks).toHaveLength(1));

    act(() => scheduledTasks[0]?.());
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2));
    expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 1, queued: 10 });

    view.rerender(
      <Wrapper>
        {climbUuids.slice(0, 50).map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
      </Wrapper>,
    );
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().queued).toBe(0));

    view.rerender(
      <Wrapper>
        {climbUuids.slice(0, 50).map((climbUuid) => (
          <StatsRow key={climbUuid} climbUuid={climbUuid} />
        ))}
        <StatsRow climbUuid="retry-owner-new" />
      </Wrapper>,
    );
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().queued).toBe(1));
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2);

    await act(async () => rejectRetry(rateLimitError(6)));
    await waitFor(() => {
      expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2);
      expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 0, queued: 0 });
    });
    // Same-auth arrivals belong to the exhausted attempt. They may run only
    // after a later fresh trigger (remount/reconnect), never as request #3.
    expect(scheduledTasks).toHaveLength(1);
    view.unmount();
  });

  it('cancels the one lane timer when every affected UUID unmounts', async () => {
    const fetchClimbStatsForClimbs = vi.fn().mockRejectedValueOnce(rateLimitError(5));
    const scheduledTasks: Array<{
      callback: () => void;
      cancel: ReturnType<typeof vi.fn>;
    }> = [];
    const { wrapper: Wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      scheduleTask: (callback) => {
        const cancel = vi.fn();
        scheduledTasks.push({ callback, cancel });
        return cancel;
      },
    });

    function StatsRow({ climbUuid }: { climbUuid: string }) {
      useEffectiveClimbStats('kilter', 1, climbUuid, 40, { ascensionistCount: 0 });
      return null;
    }
    const view = render(
      <Wrapper>
        <StatsRow climbUuid="unmount-rate-a" />
        <StatsRow climbUuid="unmount-rate-b" />
      </Wrapper>,
    );
    await waitFor(() => expect(scheduledTasks).toHaveLength(1));

    view.unmount();
    await waitFor(() => expect(scheduledTasks[0]?.cancel).toHaveBeenCalledTimes(1));
    expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 0, queued: 0 });
    act(() => scheduledTasks[0]?.callback());
    await act(async () => Promise.resolve());
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);
  });

  it('fences the one-shot rate-limit retry by auth epoch', async () => {
    let authEpoch = 1;
    const fetchClimbStatsForClimbs = vi
      .fn()
      .mockRejectedValue(new Error('Rate limit exceeded. Try again in 3 seconds.'));
    const scheduledTasks: Array<() => void> = [];
    const { wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      captureAuthEpoch: () => authEpoch,
      isAuthEpochCurrent: (capturedEpoch) => capturedEpoch === authEpoch,
      scheduleTask: (callback) => {
        scheduledTasks.push(callback);
        return vi.fn();
      },
    });

    renderHook(() => useEffectiveClimbStats('kilter', 1, 'climb-rate', 40, { ascensionistCount: 0 }), { wrapper });
    await waitFor(() => expect(scheduledTasks).toHaveLength(1));
    authEpoch = 2;
    act(() => scheduledTasks[0]?.());
    await act(async () => Promise.resolve());
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);
  });

  it('does not let a late old-auth rejection pause a newly queued auth generation', async () => {
    let authEpoch = 1;
    let rejectOldAuth = (_error: unknown) => {};
    const fetchClimbStatsForClimbs = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ClimbStatsForClimbEntry[]>((_resolve, reject) => {
            rejectOldAuth = reject;
          }),
      )
      .mockResolvedValueOnce([]);
    const scheduledTasks: Array<() => void> = [];
    const { wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      captureAuthEpoch: () => authEpoch,
      isAuthEpochCurrent: (capturedEpoch) => capturedEpoch === authEpoch,
      scheduleTask: (callback) => {
        scheduledTasks.push(callback);
        return vi.fn();
      },
    });
    const oldAuth = renderHook(
      () => useEffectiveClimbStats('kilter', 1, 'old-auth-climb', 40, { ascensionistCount: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1));

    authEpoch = 2;
    const newAuth = renderHook(
      () => useEffectiveClimbStats('kilter', 1, 'new-auth-climb', 40, { ascensionistCount: 0 }),
      { wrapper },
    );
    await act(async () => rejectOldAuth(rateLimitError(8)));

    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2));
    expect(fetchClimbStatsForClimbs.mock.calls[1]?.[1]).toEqual(['new-auth-climb']);
    expect(scheduledTasks).toHaveLength(0);
    oldAuth.unmount();
    newAuth.unmount();
  });

  it('preserves new-auth work queued while the old-auth lane retry is in flight', async () => {
    let authEpoch = 1;
    let rejectOldAuthRetry = (_error: unknown) => {};
    const fetchClimbStatsForClimbs = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError(5))
      .mockImplementationOnce(
        () =>
          new Promise<ClimbStatsForClimbEntry[]>((_resolve, reject) => {
            rejectOldAuthRetry = reject;
          }),
      )
      .mockResolvedValueOnce([]);
    const scheduledTasks: Array<() => void> = [];
    const { wrapper } = createWrapper({
      fetchClimbStatsForClimbs,
      captureAuthEpoch: () => authEpoch,
      isAuthEpochCurrent: (capturedEpoch) => capturedEpoch === authEpoch,
      scheduleTask: (callback) => {
        scheduledTasks.push(callback);
        return vi.fn();
      },
    });
    const oldAuth = renderHook(
      () => useEffectiveClimbStats('kilter', 1, 'retry-old-auth', 40, { ascensionistCount: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(scheduledTasks).toHaveLength(1));

    act(() => scheduledTasks[0]?.());
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2));

    authEpoch = 2;
    const newAuth = renderHook(
      () => useEffectiveClimbStats('kilter', 1, 'retry-new-auth', 40, { ascensionistCount: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().queued).toBe(1));
    expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2);

    await act(async () => rejectOldAuthRetry(rateLimitError(5)));
    await waitFor(() => {
      expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(3);
      expect(getClimbStatsReadCoordinatorStateForTests()).toMatchObject({ active: 0, queued: 0 });
    });
    expect(fetchClimbStatsForClimbs.mock.calls[0]?.[1]).toEqual(['retry-old-auth']);
    expect(fetchClimbStatsForClimbs.mock.calls[1]?.[1]).toEqual(['retry-old-auth']);
    expect(fetchClimbStatsForClimbs.mock.calls[2]?.[1]).toEqual(['retry-new-auth']);
    expect(scheduledTasks).toHaveLength(1);
    oldAuth.unmount();
    newAuth.unmount();
  });

  it('keeps one physical flight globally while a paused lane yields to other boards and adapters', async () => {
    const scheduledTasks: Array<() => void> = [];
    const pendingAdapterA: Array<{ boardType: string; resolve: (rows: ClimbStatsForClimbEntry[]) => void }> = [];
    let firstKilterRequest = true;
    const fetchAdapterA = vi.fn((boardType: string) => {
      if (boardType === 'kilter' && firstKilterRequest) {
        firstKilterRequest = false;
        return Promise.reject(rateLimitError(3));
      }
      return new Promise<ClimbStatsForClimbEntry[]>((resolve) => {
        pendingAdapterA.push({ boardType, resolve });
      });
    });
    const pendingAdapterB: Array<(rows: ClimbStatsForClimbEntry[]) => void> = [];
    const fetchAdapterB = vi.fn(
      () =>
        new Promise<ClimbStatsForClimbEntry[]>((resolve) => {
          pendingAdapterB.push(resolve);
        }),
    );
    const { wrapper: WrapperA } = createWrapper({
      fetchClimbStatsForClimbs: fetchAdapterA,
      scheduleTask: (callback) => {
        scheduledTasks.push(callback);
        return vi.fn();
      },
    });
    const { wrapper: WrapperB } = createWrapper({ fetchClimbStatsForClimbs: fetchAdapterB });

    const paused = renderHook(
      () => useEffectiveClimbStats('kilter', 1, 'adapter-a-kilter', 40, { ascensionistCount: 0 }),
      { wrapper: WrapperA },
    );
    await waitFor(() => expect(scheduledTasks).toHaveLength(1));

    const otherBoard = renderHook(
      () => useEffectiveClimbStats('tension', 1, 'adapter-a-tension', 40, { ascensionistCount: 0 }),
      { wrapper: WrapperA },
    );
    await waitFor(() => expect(fetchAdapterA).toHaveBeenCalledTimes(2));
    expect(pendingAdapterA[0]?.boardType).toBe('tension');

    const otherAdapter = renderHook(
      () => useEffectiveClimbStats('kilter', 1, 'adapter-b-kilter', 40, { ascensionistCount: 0 }),
      { wrapper: WrapperB },
    );
    await act(async () => Promise.resolve());
    expect(fetchAdapterB).not.toHaveBeenCalled();

    act(() => scheduledTasks[0]?.());
    await act(async () => Promise.resolve());
    expect(fetchAdapterA).toHaveBeenCalledTimes(2);
    expect(fetchAdapterB).not.toHaveBeenCalled();

    await act(async () => pendingAdapterA[0]?.resolve([]));
    await waitFor(() => expect(fetchAdapterA).toHaveBeenCalledTimes(3));
    expect(fetchAdapterA.mock.calls[2]?.[0]).toBe('kilter');
    expect(fetchAdapterB).not.toHaveBeenCalled();

    await act(async () => pendingAdapterA[1]?.resolve([]));
    await waitFor(() => expect(fetchAdapterB).toHaveBeenCalledTimes(1));
    await act(async () => pendingAdapterB[0]?.([]));
    await waitFor(() => expect(getClimbStatsReadCoordinatorStateForTests().active).toBe(0));

    paused.unmount();
    otherBoard.unmount();
    otherAdapter.unmount();
  });

  it('retires only the acknowledged token captured by each successful primary repair', async () => {
    const pendingBatches: Array<(rows: ClimbStatsForClimbEntry[]) => void> = [];
    const fetchClimbStatsForClimbs = vi.fn(
      () =>
        new Promise<ClimbStatsForClimbEntry[]>((resolve) => {
          pendingBatches.push(resolve);
        }),
    );
    const { wrapper, adapter } = createWrapper({ fetchClimbStatsForClimbs });
    const statsKey: ClimbStatsKey = {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'climb-token',
      angle: 40,
    };
    renderHook(() => useEffectiveClimbStats('kilter', 1, 'climb-token', 40, { ascensionistCount: 5 }), { wrapper });
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(1));

    act(() => {
      beginOptimisticAscent(statsKey, 'token-1', 0, 10);
      acknowledgeOptimisticAscent('token-1', 0);
      scheduleAcknowledgedClimbStatsRead(adapter, statsKey, undefined, 'token-1');
    });
    await act(async () => pendingBatches[0]?.([batchRow('climb-token', 5, '1')]));
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(2));

    act(() => {
      beginOptimisticAscent(statsKey, 'token-2', 0, 20);
      acknowledgeOptimisticAscent('token-2', 0);
      scheduleAcknowledgedClimbStatsRead(adapter, statsKey, undefined, 'token-2');
    });
    await act(async () => pendingBatches[1]?.([batchRow('climb-token', 5, '2')]));
    await waitFor(() => expect(fetchClimbStatsForClimbs).toHaveBeenCalledTimes(3));
    expect(getClimbStatsSnapshot(statsKey).optimisticFloor).toBe(21);
    expect(getAcknowledgedClimbStatsTokens('kilter', 'climb-token', 0)).toEqual(['token-2']);

    await act(async () => pendingBatches[2]?.([batchRow('climb-token', 5, '3')]));
    await waitFor(() => expect(getClimbStatsSnapshot(statsKey).optimisticFloor).toBeNull());
  });
});

describe('useClimbStatsLayoutSync — persisting events locally', () => {
  beforeEach(() => {
    resetClimbStatsStoreForTests();
    resetClimbStatsReadCoordinatorForTests();
  });

  function streamEvent(overrides: Partial<ClimbStatsEvent> = {}): ClimbStatsEvent {
    return {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'climb-1',
      angle: 40,
      ascensionistCount: 9,
      qualityAverage: 3,
      difficultyAverage: 18.5,
      displayDifficulty: 18,
      difficulty: '6b/V4',
      faUsername: null,
      faAt: null,
      syncSeq: '77',
      ...overrides,
    };
  }

  function mountLayoutSync(persistClimbStatsEvent?: (event: ClimbStatsEvent) => void) {
    let deliver: ((event: ClimbStatsEvent) => void) | undefined;
    const { wrapper } = createWrapper({
      fetchClimbStatsForClimbs: vi.fn().mockResolvedValue([]),
      subscribeClimbStats: (_boardType, _layoutId, handlers) => {
        deliver = handlers.next;
        return vi.fn();
      },
      persistClimbStatsEvent,
    });
    const view = renderHook(() => useClimbStatsLayoutSync('kilter', 1), { wrapper });
    return { deliver: (event: ClimbStatsEvent) => act(() => deliver?.(event)), view };
  }

  it('persists an event no mounted selector retains', () => {
    const seenCanonical: Array<unknown> = [];
    const persist = vi.fn((event: ClimbStatsEvent) => {
      // Nothing retains this key, so the store dropped the payload — which is
      // exactly why the local catalog needs its own copy.
      seenCanonical.push(
        getClimbStatsSnapshot({ boardType: 'kilter', layoutId: 1, climbUuid: event.climbUuid, angle: event.angle })
          .canonical,
      );
    });
    const { deliver } = mountLayoutSync(persist);

    deliver(streamEvent());

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toMatchObject({ climbUuid: 'climb-1', syncSeq: '77' });
    expect(seenCanonical).toEqual([null]);
  });

  it('never persists an event from another board or layout', () => {
    const persist = vi.fn();
    const { deliver } = mountLayoutSync(persist);

    deliver(streamEvent({ boardType: 'tension' }));
    deliver(streamEvent({ layoutId: 8 }));

    expect(persist).not.toHaveBeenCalled();
  });

  it('runs after the store, so the persisted event is already the store’s canonical revision', () => {
    const order: string[] = [];
    const statsKey: ClimbStatsKey = { boardType: 'kilter', layoutId: 1, climbUuid: 'climb-1', angle: 40 };
    const unsubscribe = subscribeClimbStats(statsKey, () => order.push('store'));
    const revisionsSeenByPersist: Array<string | null | undefined> = [];
    const persist = vi.fn(() => {
      order.push('persist');
      revisionsSeenByPersist.push(getClimbStatsSnapshot(statsKey).canonical?.syncSeq);
    });
    const { deliver } = mountLayoutSync(persist);

    deliver(streamEvent());

    expect(order).toEqual(['store', 'persist']);
    expect(revisionsSeenByPersist).toEqual(['77']);
    unsubscribe();
  });

  it('is optional — an adapter without it handles events unchanged', () => {
    const statsKey: ClimbStatsKey = { boardType: 'kilter', layoutId: 1, climbUuid: 'climb-1', angle: 40 };
    const unsubscribe = subscribeClimbStats(statsKey, vi.fn());
    const { deliver } = mountLayoutSync(undefined);

    expect(() => deliver(streamEvent())).not.toThrow();
    expect(getClimbStatsSnapshot(statsKey).canonical?.ascensionistCount).toBe(9);
    unsubscribe();
  });
});
