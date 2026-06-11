import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';

// ── Native module mocks ───────────────────────────────────────────────────

const appStateAddListener = vi.fn((..._args: unknown[]) => ({ remove: vi.fn() }));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (...args: unknown[]) => appStateAddListener(...args),
  },
}));

const netInfoAddListener = vi.fn((..._args: unknown[]) => vi.fn());
vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: (...args: unknown[]) => netInfoAddListener(...args),
  },
}));

vi.mock('../pull-client', () => ({
  pullSync: vi.fn().mockResolvedValue(undefined),
}));

import { triggerSync, startSyncScheduler, __resetSyncSchedulerStateForTests, type DrainQueue } from '../sync-scheduler';
import { pullSync } from '../pull-client';

const mockPullSync = pullSync as ReturnType<typeof vi.fn>;

const mockDb = {} as SQLiteDatabase;
function createMockQueryClient() {
  return { invalidateQueries: vi.fn() } as unknown as QueryClient;
}
const mockGraphqlFetch = vi.fn().mockResolvedValue({});
const getEnabledBoards = () => ['kilter'];

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
    warnSpy.mockRestore();
  });

  it('swallows a throwing cycle without rejecting and clears the in-flight lock', async () => {
    const drainQueue: DrainQueue = vi.fn().mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const queryClient = createMockQueryClient();
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();

    // A subsequent independent trigger must be able to run (lock released).
    const drainQueue2: DrainQueue = vi.fn().mockResolvedValue(undefined);
    triggerSync(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue2);
    await flush();

    expect(drainQueue2).toHaveBeenCalledTimes(1);
    expect(mockPullSync).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('startSyncScheduler runs an initial cycle and wires native listeners', async () => {
    const drainQueue: DrainQueue = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    const stop = startSyncScheduler(mockDb, queryClient, mockGraphqlFetch, getEnabledBoards, drainQueue);
    await flush();

    expect(drainQueue).toHaveBeenCalledTimes(1);
    expect(mockPullSync).toHaveBeenCalledTimes(1);
    expect(appStateAddListener).toHaveBeenCalledTimes(1);
    expect(netInfoAddListener).toHaveBeenCalledTimes(1);

    // Cleanup unsubscribes both listeners without throwing.
    expect(() => stop()).not.toThrow();
  });
});
