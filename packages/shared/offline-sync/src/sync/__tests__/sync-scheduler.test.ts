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
});
