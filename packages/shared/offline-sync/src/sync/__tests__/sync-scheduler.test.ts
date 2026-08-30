import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase, QueryInvalidator } from '../../database';

vi.mock('../pull-client', () => ({
  pullSync: vi.fn().mockResolvedValue(undefined),
}));

import {
  triggerSync,
  startSyncScheduler,
  __resetSyncSchedulerStateForTests,
  type DrainQueue,
  type SchedulerTriggers,
} from '../sync-scheduler';
import { pullSync } from '../pull-client';
import { beginScopePurge, __resetDrainerStateForTests } from '../../mutation-queue/drainer';

const mockPullSync = pullSync as ReturnType<typeof vi.fn>;

const mockDb = {} as OfflineDatabase;
function createMockQueryClient() {
  return { invalidateQueries: vi.fn() } as unknown as QueryInvalidator;
}
const mockGraphqlFetch = vi.fn().mockResolvedValue({});
const getEnabledBoards = () => ['kilter'];

// Fake platform triggers standing in for the mobile adapter's AppState/NetInfo
// subscriptions. Tests fire them by hand.
function createFakeTriggers() {
  let foregroundCallback: (() => void) | null = null;
  let connectivityCallback: ((isConnected: boolean) => void) | null = null;
  const unsubscribeForeground = vi.fn();
  const unsubscribeConnectivity = vi.fn();
  const triggers: SchedulerTriggers = {
    subscribeForeground(callback) {
      foregroundCallback = callback;
      return unsubscribeForeground;
    },
    subscribeConnectivity(callback) {
      connectivityCallback = callback;
      return unsubscribeConnectivity;
    },
  };
  return {
    triggers,
    fireForeground: () => foregroundCallback?.(),
    fireConnectivity: (isConnected: boolean) => connectivityCallback?.(isConnected),
    isForegroundWired: () => foregroundCallback !== null,
    isConnectivityWired: () => connectivityCallback !== null,
    unsubscribeForeground,
    unsubscribeConnectivity,
  };
}

// Lets a test resolve an in-flight async step on demand.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush microtasks so chained awaits inside runSync settle.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('sync-scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSyncSchedulerStateForTests();
    __resetDrainerStateForTests();
    mockPullSync.mockResolvedValue(undefined);
  });

  it('drains (push) before pulling (fetch) on a trigger', async () => {
    const order: string[] = [];
    const drainQueue: DrainQueue = vi.fn(async () => {
      order.push('drain');
    });
    mockPullSync.mockImplementation(async () => {
      order.push('pull');
    });

    const queryClient = createMockQueryClient();
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();

    expect(order).toEqual(['drain', 'pull']);
    expect(drainQueue).toHaveBeenCalledTimes(1);
    expect(mockPullSync).toHaveBeenCalledTimes(1);
    // pull receives the enabled boards from the getter
    expect(mockPullSync).toHaveBeenCalledWith(
      mockDb,
      queryClient,
      mockGraphqlFetch,
      expect.objectContaining({ enabledBoards: ['kilter'] }),
    );
  });

  it('never drains personal mutations during a catalog-only cycle', async () => {
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);

    triggerSync(mockDb, createMockQueryClient(), mockGraphqlFetch, getEnabledBoards, drainQueue, {
      catalogOnly: true,
    });
    await flush();

    expect(drainQueue).not.toHaveBeenCalled();
    expect(mockPullSync).toHaveBeenCalledWith(
      mockDb,
      expect.anything(),
      mockGraphqlFetch,
      expect.objectContaining({ enabledBoards: ['kilter'], catalogOnly: true }),
    );
  });

  it('forwards per-scope bootstrap metadata settlement to pullSync', async () => {
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const onBootstrapMetadataChanged = vi.fn();

    triggerSync(mockDb, createMockQueryClient(), mockGraphqlFetch, getEnabledBoards, drainQueue, {
      onBootstrapMetadataChanged,
    });
    await flush();

    expect(mockPullSync).toHaveBeenCalledWith(
      mockDb,
      expect.anything(),
      mockGraphqlFetch,
      expect.objectContaining({ onBootstrapMetadataChanged }),
    );
  });

  it('threads the connectivity probe into pullSync, and omits it when the caller has none (#4238)', async () => {
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const isOnline = () => false;

    triggerSync(mockDb, createMockQueryClient(), mockGraphqlFetch, getEnabledBoards, drainQueue, { isOnline });
    await flush();

    expect(mockPullSync).toHaveBeenCalledWith(
      mockDb,
      expect.anything(),
      mockGraphqlFetch,
      expect.objectContaining({ isOnline }),
    );

    // No probe supplied → pullSync gets `undefined` and keeps its assume-online
    // default, so today's callers are unchanged.
    vi.clearAllMocks();
    __resetSyncSchedulerStateForTests();
    triggerSync(mockDb, createMockQueryClient(), mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();

    const options = mockPullSync.mock.calls[0][3] as { isOnline?: () => boolean };
    expect(options.isOnline).toBeUndefined();
  });

  it('single-flights concurrent triggers into one run plus one follow-up', async () => {
    const drainGate = deferred();
    const drainQueue: DrainQueue = vi.fn(() => drainGate.promise);

    const queryClient = createMockQueryClient();

    // First trigger: enters runSync, awaits drainQueue (stuck on the gate).
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(1);

    // Second trigger while the first is in flight: must NOT start a new run,
    // only set the pending flag.
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(1);
    expect(mockPullSync).not.toHaveBeenCalled();

    // Release the first run; the pending follow-up runs exactly once.
    drainGate.resolve();
    await flush();

    expect(drainQueue).toHaveBeenCalledTimes(2);
    expect(mockPullSync).toHaveBeenCalledTimes(2);
  });

  it('runs a queued follow-up with the latest source, options, and enabled-board reader', async () => {
    const firstDrain = deferred();
    const firstQueue: DrainQueue = vi.fn(() => firstDrain.promise);
    const latestQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();
    const latestSnapshotSource = { fetchManifest: vi.fn() } as never;
    const latestProgress = vi.fn();

    triggerSync(mockDb, queryClient, mockGraphqlFetch, () => ['kilter:1:5'], firstQueue, {
      snapshotSource: undefined,
    });
    await flush();

    // This is the cold-start race: the replacement scheduler now has snapshot
    // I/O, but the old implementation remembered only a boolean and replayed
    // the first run's undefined source.
    triggerSync(mockDb, queryClient, mockGraphqlFetch, () => ['tension:11:8'], latestQueue, {
      snapshotSource: latestSnapshotSource,
      onProgress: latestProgress,
    });
    firstDrain.resolve();
    await flush();

    expect(firstQueue).toHaveBeenCalledTimes(1);
    expect(latestQueue).toHaveBeenCalledTimes(1);
    expect(mockPullSync).toHaveBeenCalledTimes(2);
    expect(mockPullSync.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({
        enabledBoards: ['tension:11:8'],
        snapshotSource: latestSnapshotSource,
        onProgress: latestProgress,
      }),
    );
  });

  it('coalesces queued replacements with latest-wins semantics', async () => {
    const firstDrain = deferred();
    const firstQueue: DrainQueue = vi.fn(() => firstDrain.promise);
    const middleQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const latestQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    triggerSync(mockDb, queryClient, mockGraphqlFetch, () => ['first'], firstQueue);
    await flush();
    triggerSync(mockDb, queryClient, mockGraphqlFetch, () => ['middle'], middleQueue);
    triggerSync(mockDb, queryClient, mockGraphqlFetch, () => ['latest'], latestQueue);

    firstDrain.resolve();
    await flush();

    expect(middleQueue).not.toHaveBeenCalled();
    expect(latestQueue).toHaveBeenCalledTimes(1);
    expect(mockPullSync.mock.calls[1]?.[3]).toEqual(expect.objectContaining({ enabledBoards: ['latest'] }));
  });

  it('collapses many concurrent triggers into at most one follow-up', async () => {
    const drainGate = deferred();
    let drainCalls = 0;
    const drainQueue: DrainQueue = vi.fn(() => {
      drainCalls += 1;
      // Only the first call blocks; the follow-up resolves immediately.
      return drainCalls === 1 ? drainGate.promise : Promise.resolve();
    });

    const queryClient = createMockQueryClient();

    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();

    // Five more triggers while the first is in flight.
    for (let i = 0; i < 5; i++) {
      triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    }
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(1);

    drainGate.resolve();
    await flush();

    // Six triggers collapse to: the initial run (which completes its pull once
    // the gate releases) + exactly one coalesced follow-up = 2 cycles total,
    // not 6.
    expect(drainQueue).toHaveBeenCalledTimes(2);
    expect(mockPullSync).toHaveBeenCalledTimes(2);
  });

  it('still runs the queued follow-up exactly once when the current run throws (I1)', async () => {
    const drainGate = deferred();
    let drainCalls = 0;
    const drainQueue: DrainQueue = vi.fn(() => {
      drainCalls += 1;
      if (drainCalls === 1) return drainGate.promise; // first run gated
      return Promise.resolve(); // follow-up succeeds
    });

    const queryClient = createMockQueryClient();

    // First run enters and awaits the gated drain.
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();

    // Queue a follow-up while in flight.
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(1);

    // Make the first run throw (rejected drain). The follow-up must still fire.
    drainGate.reject(new Error('drain blew up'));
    await flush();

    expect(drainQueue).toHaveBeenCalledTimes(2);
    expect(mockPullSync).toHaveBeenCalledTimes(1); // only the follow-up pulled
  });

  it('swallows a throwing cycle without rejecting, reports it, and clears the in-flight lock', async () => {
    const cycleError = new Error('boom');
    const drainQueue: DrainQueue = vi.fn().mockRejectedValue(cycleError);
    const onCycleError = vi.fn();

    const queryClient = createMockQueryClient();
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue, { onCycleError });
    await flush();

    expect(onCycleError).toHaveBeenCalledWith(cycleError);

    // A subsequent independent trigger must be able to run (lock released).
    const drainQueue2: DrainQueue = vi.fn().mockResolvedValue(undefined);
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue2);
    await flush();

    expect(drainQueue2).toHaveBeenCalledTimes(1);
    expect(mockPullSync).toHaveBeenCalledTimes(1);
  });

  it('keeps retry and failed-idle lifecycle intact when the cycle-error reporter throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
    try {
      const cycleError = new Error('pull failed');
      const reporterError = new Error('telemetry failed');
      const drainQueue: DrainQueue = vi.fn().mockRejectedValueOnce(cycleError).mockResolvedValue(undefined);
      const onProgress = vi.fn();
      const onCycleError = vi.fn(() => {
        throw reporterError;
      });
      const stop = startSyncScheduler(
        mockDb,
        createMockQueryClient(),
        mockGraphqlFetch,
        getEnabledBoards,
        drainQueue,
        createFakeTriggers().triggers,
        { onCycleError, onProgress },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onCycleError).toHaveBeenCalledWith(cycleError);
      expect(onProgress).toHaveBeenCalledWith({
        phase: 'idle',
        currentTable: null,
        documentsProcessed: 0,
        failed: true,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(drainQueue).toHaveBeenCalledTimes(2);
      expect(mockPullSync).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('startSyncScheduler runs an initial cycle and wires the injected triggers', async () => {
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();
    const fakeTriggers = createFakeTriggers();

    const stop = startSyncScheduler(
      mockDb,
      queryClient,
      mockGraphqlFetch,
      getEnabledBoards,
      drainQueue,
      fakeTriggers.triggers,
    );
    await flush();

    expect(drainQueue).toHaveBeenCalledTimes(1);
    expect(mockPullSync).toHaveBeenCalledTimes(1);
    expect(fakeTriggers.isForegroundWired()).toBe(true);
    expect(fakeTriggers.isConnectivityWired()).toBe(true);

    // Cleanup unsubscribes both listeners without throwing.
    expect(() => stop()).not.toThrow();
    expect(fakeTriggers.unsubscribeForeground).toHaveBeenCalledTimes(1);
    expect(fakeTriggers.unsubscribeConnectivity).toHaveBeenCalledTimes(1);
  });

  it('debounces foreground triggers and syncs after the quiet period', async () => {
    vi.useFakeTimers();
    try {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const queryClient = createMockQueryClient();
      const fakeTriggers = createFakeTriggers();

      startSyncScheduler(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue, fakeTriggers.triggers);
      await vi.advanceTimersByTimeAsync(0); // initial cycle settles
      expect(drainQueue).toHaveBeenCalledTimes(1);

      // Two rapid foreground events coalesce into one debounced run.
      fakeTriggers.fireForeground();
      fakeTriggers.fireForeground();
      await vi.advanceTimersByTimeAsync(1999);
      expect(drainQueue).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(drainQueue).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncs only on the offline→online connectivity edge', async () => {
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();
    const fakeTriggers = createFakeTriggers();

    startSyncScheduler(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue, fakeTriggers.triggers);
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(1); // initial cycle

    // Already-connected report: no extra run (starts assumed connected).
    fakeTriggers.fireConnectivity(true);
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(1);

    // Drop offline: no run.
    fakeTriggers.fireConnectivity(false);
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(1);

    // Reconnect: exactly one run.
    fakeTriggers.fireConnectivity(true);
    await flush();
    expect(drainQueue).toHaveBeenCalledTimes(2);
  });

  it('wakes exactly when an absolute snapshot retry deadline is due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    try {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const fakeTriggers = createFakeTriggers();
      let pullCalls = 0;
      mockPullSync.mockImplementation(async (_db, _queryClient, _fetch, options) => {
        pullCalls += 1;
        if (pullCalls === 1) {
          options.onBootstrapRetryDue?.({ scopeKey: 'kilter:1:5', retryAt: Date.now() + 2_000 });
        }
      });

      const stop = startSyncScheduler(
        mockDb,
        createMockQueryClient(),
        mockGraphqlFetch,
        getEnabledBoards,
        drainQueue,
        fakeTriggers.triggers,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullSync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(mockPullSync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockPullSync).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains later scope deadlines when the earliest retry wakes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    try {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const fakeTriggers = createFakeTriggers();
      mockPullSync.mockImplementationOnce(async (_db, _queryClient, _fetch, options) => {
        options.onBootstrapRetryDue?.({ scopeKey: 'tension:11:8', retryAt: Date.now() + 5_000 });
        options.onBootstrapRetryDue?.({ scopeKey: 'kilter:1:5', retryAt: Date.now() + 1_000 });
      });

      const stop = startSyncScheduler(
        mockDb,
        createMockQueryClient(),
        mockGraphqlFetch,
        getEnabledBoards,
        drainQueue,
        fakeTriggers.triggers,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockPullSync).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(mockPullSync).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockPullSync).toHaveBeenCalledTimes(3);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an ad-hoc trigger arm the active scheduler retry timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    try {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const fakeTriggers = createFakeTriggers();
      const stop = startSyncScheduler(
        mockDb,
        createMockQueryClient(),
        mockGraphqlFetch,
        getEnabledBoards,
        drainQueue,
        fakeTriggers.triggers,
      );
      await vi.advanceTimersByTimeAsync(0);

      mockPullSync.mockImplementationOnce(async (_db, _queryClient, _fetch, options) => {
        options.onBootstrapRetryDue?.({ scopeKey: 'kilter:1:5', retryAt: Date.now() + 500 });
      });
      triggerSync(mockDb, createMockQueryClient(), mockGraphqlFetch, getEnabledBoards, drainQueue);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPullSync).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(500);
      expect(mockPullSync).toHaveBeenCalledTimes(3);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels retry alarms when the scheduler stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    try {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const fakeTriggers = createFakeTriggers();
      mockPullSync.mockImplementationOnce(async (_db, _queryClient, _fetch, options) => {
        options.onBootstrapRetryDue?.({ scopeKey: 'kilter:1:5', retryAt: Date.now() + 1_000 });
      });
      const stop = startSyncScheduler(
        mockDb,
        createMockQueryClient(),
        mockGraphqlFetch,
        getEnabledBoards,
        drainQueue,
        fakeTriggers.triggers,
      );
      await vi.advanceTimersByTimeAsync(0);
      stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockPullSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a cycle error while the app remains foregrounded and connected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
    try {
      const cycleError = new Error('paged request failed');
      const drainQueue: DrainQueue = vi.fn().mockRejectedValueOnce(cycleError).mockResolvedValue(undefined);
      const onCycleError = vi.fn();
      const stop = startSyncScheduler(
        mockDb,
        createMockQueryClient(),
        mockGraphqlFetch,
        getEnabledBoards,
        drainQueue,
        createFakeTriggers().triggers,
        { onCycleError },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onCycleError).toHaveBeenCalledWith(cycleError);
      expect(drainQueue).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(drainQueue).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(drainQueue).toHaveBeenCalledTimes(2);
      expect(mockPullSync).toHaveBeenCalledTimes(1);

      // The successful retry clears the generic alarm; it must not loop.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(drainQueue).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a trigger queued behind an in-flight cycle does NOT re-run after cleanup', async () => {
    // Sign-out / flag-flip stops the scheduler while a cycle is mid-pull; the
    // pending follow-up captured before the stop must die with it, or a "new"
    // sync fires with nothing mounted to own it.
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();
    const fakeTriggers = createFakeTriggers();
    const inFlightPull = deferred();
    mockPullSync.mockImplementation(() => inFlightPull.promise);

    const stop = startSyncScheduler(
      mockDb,
      queryClient,
      mockGraphqlFetch,
      getEnabledBoards,
      drainQueue,
      fakeTriggers.triggers,
    );
    await flush();
    expect(mockPullSync).toHaveBeenCalledTimes(1);

    // A trigger arrives while the initial cycle is still pulling → queued.
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();

    // Scheduler stops before the in-flight cycle finishes.
    stop();
    inFlightPull.resolve();
    await flush();

    // The queued follow-up must NOT have fired a second cycle.
    expect(mockPullSync).toHaveBeenCalledTimes(1);
  });

  it('hands an in-flight cycle off to a replacement scheduler with its new snapshot source', async () => {
    const oldPull = deferred();
    mockPullSync.mockImplementationOnce(() => oldPull.promise).mockResolvedValue(undefined);
    const oldTriggers = createFakeTriggers();
    const newTriggers = createFakeTriggers();
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    const stopOld = startSyncScheduler(
      mockDb,
      queryClient,
      mockGraphqlFetch,
      () => ['kilter:1:5'],
      drainQueue,
      oldTriggers.triggers,
      { snapshotSource: undefined },
    );
    await flush();
    expect(mockPullSync).toHaveBeenCalledTimes(1);

    stopOld();
    const snapshotSource = { fetchManifest: vi.fn() } as never;
    const stopNew = startSyncScheduler(
      mockDb,
      queryClient,
      mockGraphqlFetch,
      () => ['tension:11:8'],
      drainQueue,
      newTriggers.triggers,
      { snapshotSource },
    );
    await flush();
    expect(mockPullSync).toHaveBeenCalledTimes(1);

    oldPull.resolve();
    await flush();
    expect(mockPullSync).toHaveBeenCalledTimes(2);
    expect(mockPullSync.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ enabledBoards: ['tension:11:8'], snapshotSource }),
    );
    stopNew();
  });

  // Issue #4406. A removal's exclusive transaction latches its namespace for
  // seconds, and every guard in the pull client reads that latch as "purged" —
  // so a cycle kicked DURING it (the climber switching the board straight back
  // on, two seconds later) skips the scope from top to bottom and reports
  // nothing. Nothing picks it up afterwards: the scheduler wakes on foreground
  // and on the offline→online edge and has no interval, so a phone that stays in
  // the climber's hand never downloads that board again.
  describe('a purge window closing', () => {
    it('re-runs a cycle when the purged namespace still has an enabled board', async () => {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const queryClient = createMockQueryClient();
      const fakeTriggers = createFakeTriggers();

      startSyncScheduler(
        mockDb,
        queryClient,
        mockGraphqlFetch,
        () => ['tension:11:8'],
        drainQueue,
        fakeTriggers.triggers,
      );
      await flush();
      expect(mockPullSync).toHaveBeenCalledTimes(1); // initial cycle

      // The removal: epoch bump, exclusive transaction, release.
      const release = beginScopePurge('tension:11');
      await flush();
      expect(mockPullSync).toHaveBeenCalledTimes(1); // nothing runs INTO the delete
      release();
      await flush();

      expect(mockPullSync).toHaveBeenCalledTimes(2);
    });

    it('stays quiet when nothing enabled needs that namespace', async () => {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const queryClient = createMockQueryClient();
      const fakeTriggers = createFakeTriggers();

      startSyncScheduler(
        mockDb,
        queryClient,
        mockGraphqlFetch,
        () => ['kilter:1:5'],
        drainQueue,
        fakeTriggers.triggers,
      );
      await flush();
      expect(mockPullSync).toHaveBeenCalledTimes(1);

      beginScopePurge('tension:11')();
      await flush();

      // An ordinary removal — the board is gone and stays gone — costs no cycle.
      expect(mockPullSync).toHaveBeenCalledTimes(1);
    });

    it('stops listening once the scheduler is stopped', async () => {
      const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
      const queryClient = createMockQueryClient();
      const fakeTriggers = createFakeTriggers();

      const stop = startSyncScheduler(
        mockDb,
        queryClient,
        mockGraphqlFetch,
        () => ['tension:11:8'],
        drainQueue,
        fakeTriggers.triggers,
      );
      await flush();
      stop();

      beginScopePurge('tension:11')();
      await flush();

      expect(mockPullSync).toHaveBeenCalledTimes(1);
    });
  });
});
