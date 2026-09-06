// The adapter is the ONE place the platform seams get bound — every other suite
// mocks it out, so this file is what actually proves the bindings: the drain
// always carries the onlineManager-backed connectivity probe, the scheduler
// triggers translate AppState/NetInfo events, and schema drift reaches Sentry.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const onlineManagerIsOnline = vi.fn(() => true);
const onlineManagerSetOnline = vi.fn();
// The adapter reads the persisted download-trigger attribution (issue #4316),
// which pulls the settings store — and its native MMKV entry breaks the test
// bundler's scan. Same in-memory stand-in as remove-offline-board.test.ts.
const mockSettingsStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString: (key: string) => mockSettingsStorage.get(key),
    set: (key: string, value: string) => void mockSettingsStorage.set(key, value),
    remove: (key: string) => void mockSettingsStorage.delete(key),
    clearAll: () => mockSettingsStorage.clear(),
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

vi.mock('@tanstack/react-query', () => ({
  onlineManager: {
    isOnline: () => onlineManagerIsOnline(),
    setOnline: (online: boolean) => onlineManagerSetOnline(online),
  },
}));

type AppStateListener = (state: string) => void;
let appStateListener: AppStateListener | null = null;
const appStateRemove = vi.fn();
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: AppStateListener) => {
      appStateListener = listener;
      return { remove: appStateRemove };
    },
  },
}));

type NetInfoState = {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
  type?: string;
  details?: { isConnectionExpensive?: boolean };
};
type NetInfoListener = (state: NetInfoState) => void;
let netInfoListener: NetInfoListener | null = null;
const netInfoUnsubscribe = vi.fn();
// The cold-launch read: NetInfo's listener has not fired yet, so the metered
// probe asks for the state directly rather than assuming wifi.
const netInfoFetch = vi.fn(async (): Promise<NetInfoState> => ({ isConnected: true, type: 'wifi' }));
vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: (listener: NetInfoListener) => {
      netInfoListener = listener;
      return netInfoUnsubscribe;
    },
    fetch: () => netInfoFetch(),
  },
}));

const drainMutationQueueCore = vi.fn(async (..._args: unknown[]) => {});
const startSyncSchedulerCore = vi.fn((..._args: unknown[]) => vi.fn());
const triggerSyncCore = vi.fn();
const pullSyncCore = vi.fn(async (..._args: unknown[]) => {});
const setBackgroundedCore = vi.fn();
vi.mock('@boardsesh/offline-sync', () => ({
  drainMutationQueue: (...args: unknown[]) => drainMutationQueueCore(...args),
  startSyncScheduler: (...args: unknown[]) => startSyncSchedulerCore(...args),
  triggerSync: (...args: unknown[]) => triggerSyncCore(...args),
  pullSync: (...args: unknown[]) => pullSyncCore(...args),
  setBackgrounded: (...args: unknown[]) => setBackgroundedCore(...args),
}));

// The connectivity store (issue #4862). The adapter reads its snapshot for the
// "is a cycle worth starting?" answer, subscribes to it for the scheduler's
// reconnect edge, and hands its deduped confirmation to the drainer.
type ConnectivitySnapshotStub = {
  effectiveOffline: boolean;
  deviceReachability: 'reachable' | 'unreachable' | 'unknown';
  backend: 'reachable' | 'unreachable' | 'unknown';
  reason: string | null;
};
const connectivity = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const online = {
    effectiveOffline: false,
    deviceReachability: 'reachable',
    backend: 'reachable',
    reason: null,
  } as ConnectivitySnapshotStub;
  const state = { snapshot: { ...online } };
  return {
    state,
    listeners,
    refreshDeviceState: vi.fn(() => Promise.resolve()),
    confirmBackendAvailability: vi.fn(() => Promise.resolve(true)),
    publish(next: Partial<ConnectivitySnapshotStub>) {
      state.snapshot = { ...state.snapshot, ...next };
      for (const listener of listeners) listener();
    },
    reset() {
      state.snapshot = { ...online };
      listeners.clear();
    },
  };
});
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => connectivity.state.snapshot,
  subscribeConnectivity: (listener: () => void) => {
    connectivity.listeners.add(listener);
    return () => connectivity.listeners.delete(listener);
  },
  refreshDeviceState: () => connectivity.refreshDeviceState(),
  confirmBackendAvailability: () => connectivity.confirmBackendAvailability(),
}));

const reportHandledError = vi.fn();
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => reportHandledError(...args),
}));

const trackMock = vi.fn();
vi.mock('../../lib/analytics', () => ({ track: (...args: unknown[]) => trackMock(...args) }));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { rememberDownloadTrigger } from '../../settings';
import { __resetSyncStatusForTests, setSyncProgress } from '../../sync';
import {
  drainMutationQueue,
  startSyncScheduler,
  triggerSync,
  pullSync,
  startBackgroundTracking,
  hasUsableInternetConnection,
  subscribeMutationDelivery,
  reportScopeDownloadAbandoned,
  reportScopeDownloadAbandonedOnSignOut,
  reportScopeDownloadAbandonedOnDisable,
  __resetCoverageVerdictDedupeForTests,
  __resetCycleErrorDedupeForTests,
  __resetMeteredStateForTests,
} from '../offline-sync-adapter';
import type {
  OfflineDatabase,
  DrainOptions,
  MutationDeadLetterInfo,
  MutationDeliveryEvent,
  SchedulerTriggers,
  SchedulerOptions,
  SnapshotSource,
  SyncOptions,
} from '@boardsesh/offline-sync';

// The engine package is vi.mock'd above, so its `emptyScopeDownloadPhases`
// helper is unreachable here — this literal stands in for it. Neither grade row
// count appears, mirroring the real helper: the engine omits both rather than
// reporting a count it cannot vouch for (issue #4393).
const NO_PHASES = {
  manifestMs: 0,
  downloadMs: 0,
  importMs: 0,
  artifactBytes: 0,
  artifactReused: false,
  climbsPullMs: 0,
  statsPullMs: 0,
  gradesPullMs: 0,
};

// What the adapter actually emits from a zeroed breakdown: download/import/bytes
// ride the per-scope timings on ScopeDownloadCompleteInfo (absent when this cycle
// did not do the import), so the phase copies of them are not re-emitted.
const NO_PHASE_PROPS = {
  manifestMs: 0,
  artifactReused: false,
  climbsPullMs: 0,
  statsPullMs: 0,
  gradesPullMs: 0,
};

const db = {} as OfflineDatabase;
const invalidateQueries = vi.fn();
const queryClient = { invalidateQueries } as unknown as import('@tanstack/react-query').QueryClient;
const graphqlFetch = vi.fn() as unknown as import('@boardsesh/offline-sync').GraphQLFetch;

beforeEach(() => {
  vi.clearAllMocks();
  __resetSyncStatusForTests();
  __resetCycleErrorDedupeForTests();
  appStateListener = null;
  netInfoListener = null;
  onlineManagerIsOnline.mockReturnValue(true);
  connectivity.reset();
  connectivity.refreshDeviceState.mockResolvedValue(undefined);
  connectivity.confirmBackendAvailability.mockResolvedValue(true);
  // The trigger store is persisted, so it survives between tests unless cleared.
  mockSettingsStorage.clear();
});

describe('drainMutationQueue binding', () => {
  it('attaches the onlineManager-backed probe when the caller passes no options', async () => {
    await drainMutationQueue(db, queryClient, graphqlFetch);

    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
    onlineManagerIsOnline.mockReturnValue(true);
    expect(options.isOnline()).toBe(true);
    onlineManagerIsOnline.mockReturnValue(false);
    expect(options.isOnline()).toBe(false);
  });

  it('lets a caller-supplied probe win over the default', async () => {
    const customProbe = vi.fn(() => false);
    await drainMutationQueue(db, queryClient, graphqlFetch, { isOnline: customProbe, maxCycleAttempts: 2 });

    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
    expect(options.isOnline()).toBe(false);
    expect(customProbe).toHaveBeenCalled();
    expect(onlineManagerIsOnline).not.toHaveBeenCalled();
    expect(options.maxCycleAttempts).toBe(2);
  });

  // A 5xx is not a reason to burn a queued write's retry budget (#4862): the
  // request was fine, the server was not.
  it('attaches the store-backed server confirmation', async () => {
    await drainMutationQueue(db, queryClient, graphqlFetch);

    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
    connectivity.confirmBackendAvailability.mockResolvedValueOnce(false);
    await expect(options.confirmServerAvailability?.()).resolves.toBe(false);
    expect(connectivity.confirmBackendAvailability).toHaveBeenCalledTimes(1);
  });

  it('lets a caller-supplied server confirmation win over the default', async () => {
    const customConfirmation = vi.fn(() => Promise.resolve(false));
    await drainMutationQueue(db, queryClient, graphqlFetch, { confirmServerAvailability: customConfirmation });

    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
    await expect(options.confirmServerAvailability?.()).resolves.toBe(false);
    expect(connectivity.confirmBackendAvailability).not.toHaveBeenCalled();
  });

  it('binds core mutation-status listener failures to handled-error telemetry', async () => {
    await drainMutationQueue(db, queryClient, graphqlFetch);
    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
    const listenerError = new Error('listener failed');
    const event: MutationDeliveryEvent = {
      tableName: 'boardsesh_ticks',
      operation: 'create',
      idempotencyKey: 'private-tick-uuid',
      status: 'acknowledged',
    };

    options.onMutationStatusError?.({ error: listenerError, event });

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError).toHaveBeenCalledWith(listenerError, {
      tags: { source: 'offline-sync', kind: 'mutation-status-listener' },
      extra: { tableName: 'boardsesh_ticks', operation: 'create', status: 'acknowledged' },
    });
  });

  it('reports a throwing delivery listener once and continues to later listeners', async () => {
    const listenerError = new Error('subscriber failed');
    const throwingListener = vi.fn(() => {
      throw listenerError;
    });
    const laterListener = vi.fn();
    const unsubscribeThrowing = subscribeMutationDelivery(throwingListener);
    const unsubscribeLater = subscribeMutationDelivery(laterListener);
    const event: MutationDeliveryEvent = {
      tableName: 'boardsesh_ticks',
      operation: 'create',
      idempotencyKey: 'private-tick-uuid',
      status: 'dead_letter',
    };

    try {
      await drainMutationQueue(db, queryClient, graphqlFetch);
      const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
      options.onMutationStatus?.(event);

      expect(throwingListener).toHaveBeenCalledWith(event);
      expect(laterListener).toHaveBeenCalledWith(event);
      expect(reportHandledError).toHaveBeenCalledTimes(1);
      expect(reportHandledError).toHaveBeenCalledWith(listenerError, {
        tags: { source: 'offline-sync', kind: 'mutation-status-listener' },
        extra: { tableName: 'boardsesh_ticks', operation: 'create', status: 'dead_letter' },
      });
    } finally {
      unsubscribeThrowing();
      unsubscribeLater();
    }
  });
});

// Issue #4315: before this binding a dead-lettered write — a user action that
// will never reach the server — produced nothing in Sentry and nothing in
// PostHog. The drainer never dead-letters for lack of a connection, so every
// one of these is a real, permanent loss.
describe('dead-letter binding', () => {
  const deadLetterInfo = (overrides: Partial<MutationDeadLetterInfo> = {}): MutationDeadLetterInfo => ({
    tableName: 'user_favorites',
    operation: 'create',
    idempotencyKey: 'add:user_favorites:kilter:climb-uuid:40',
    reason: 'non_retryable',
    retryCount: 2,
    maxRetries: 10,
    queuedForMs: 90_000,
    status: 400,
    errorMessage: 'Bad Request',
    error: new Error('Bad Request'),
    ...overrides,
  });

  it('reports to Sentry with the original error as cause and to analytics without the idempotency key', async () => {
    await drainMutationQueue(db, queryClient, graphqlFetch);
    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
    const info = deadLetterInfo();

    options.onMutationDeadLettered?.(info);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [reportedError, context] = reportHandledError.mock.calls[0] as [Error, { tags: Record<string, unknown> }];
    expect(reportedError.cause).toBe(info.error);
    expect(context.tags).toEqual({ source: 'offline-sync', kind: 'mutation-dead-letter', reason: 'non_retryable' });

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineMutationDeadLettered, {
      tableName: 'user_favorites',
      operation: 'create',
      reason: 'non_retryable',
      retryCount: 2,
      status: 400,
      queuedForMs: 90_000,
      error: 'Bad Request',
    });
    const [, trackedProps] = trackMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(trackedProps).not.toHaveProperty('idempotencyKey');
  });

  it('runs telemetry even when the caller supplies its own handler', async () => {
    const callerHandler = vi.fn();
    await drainMutationQueue(db, queryClient, graphqlFetch, { onMutationDeadLettered: callerHandler });
    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;
    const info = deadLetterInfo({ reason: 'retries_exhausted' });

    options.onMutationDeadLettered?.(info);

    expect(callerHandler).toHaveBeenCalledWith(info);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('still reports when a caller-supplied handler throws', async () => {
    await drainMutationQueue(db, queryClient, graphqlFetch, {
      onMutationDeadLettered: () => {
        throw new Error('caller exploded');
      },
    });
    const options = drainMutationQueueCore.mock.calls[0][3] as DrainOptions;

    expect(() => options.onMutationDeadLettered?.(deadLetterInfo())).toThrow('caller exploded');
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledTimes(1);
  });
});

describe('startBackgroundTracking', () => {
  it('flips the engine guard on background/active transitions, ignoring the transient inactive state', () => {
    const unsubscribe = startBackgroundTracking();

    appStateListener?.('background');
    expect(setBackgroundedCore).toHaveBeenCalledTimes(1);
    expect(setBackgroundedCore).toHaveBeenLastCalledWith(true);

    appStateListener?.('inactive');
    expect(setBackgroundedCore).toHaveBeenCalledTimes(1);

    appStateListener?.('active');
    expect(setBackgroundedCore).toHaveBeenCalledTimes(2);
    expect(setBackgroundedCore).toHaveBeenLastCalledWith(false);

    unsubscribe();
    expect(appStateRemove).toHaveBeenCalledTimes(1);
  });
});

describe('scheduler trigger bindings', () => {
  function startAndGetTriggers(): { triggers: SchedulerTriggers; options: SchedulerOptions } {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const call = startSyncSchedulerCore.mock.calls[0];
    return { triggers: call[5] as SchedulerTriggers, options: call[6] as SchedulerOptions };
  }

  it('foreground trigger fires only on the active transition and unsubscribes cleanly', () => {
    const { triggers } = startAndGetTriggers();
    const callback = vi.fn();
    const unsubscribe = triggers.subscribeForeground(callback);

    appStateListener?.('background');
    expect(callback).not.toHaveBeenCalled();
    appStateListener?.('active');
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(appStateRemove).toHaveBeenCalledTimes(1);
  });

  // THE seeding bug (#4862): startSyncScheduler seeds `wasConnected = true` and
  // only runs a cycle on a false→true edge, so a scheduler started DURING an
  // outage would never see the recovery — from a seeded-true baseline, `usable`
  // going true is not an edge. The synchronous emit at subscribe time is what
  // makes the recovery an edge again.
  it('emits the current connectivity synchronously on subscribe', () => {
    connectivity.publish({ effectiveOffline: true, backend: 'unreachable', reason: 'backend_unreachable' });
    const { triggers } = startAndGetTriggers();
    const callback = vi.fn();

    triggers.subscribeConnectivity(callback);

    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('forwards only real changes after that, and unsubscribes cleanly', () => {
    const { triggers } = startAndGetTriggers();
    const callback = vi.fn();
    const unsubscribe = triggers.subscribeConnectivity(callback);
    callback.mockClear();

    // A snapshot change that does not move usability (a probe starting, a
    // failure counter ticking) must not fake an edge for the scheduler.
    connectivity.publish({ reason: null });
    expect(callback).not.toHaveBeenCalled();

    connectivity.publish({ effectiveOffline: true, backend: 'unreachable', reason: 'backend_unreachable' });
    connectivity.publish({ effectiveOffline: false, backend: 'reachable', reason: null });
    expect(callback).toHaveBeenNthCalledWith(1, false);
    expect(callback).toHaveBeenNthCalledWith(2, true);

    unsubscribe();
    connectivity.publish({ effectiveOffline: true, backend: 'unreachable' });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  // The lying connection: a captive portal or a dead gym upstream leaves the
  // link "connected", so without reachability the scheduler never sees an
  // offline→online edge and a board armed there waits for a network change
  // (issue #4318). The store now folds a confirmed BACKEND outage into the same
  // signal, so an armed scope also gets its kick when the server returns.
  it('treats a known-unreachable uplink as disconnected, so recovery is an edge', () => {
    connectivity.publish({ deviceReachability: 'unreachable' });
    const { triggers } = startAndGetTriggers();
    const callback = vi.fn();
    triggers.subscribeConnectivity(callback);
    callback.mockClear();

    connectivity.publish({ deviceReachability: 'reachable' });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
  });

  // Not-probed-yet is not unreachable — inventing a disconnect there would fake
  // an edge on every platform that answers the reachability probe late.
  it('treats unknown reachability as connected', () => {
    connectivity.publish({ deviceReachability: 'unknown' });
    const { triggers } = startAndGetTriggers();
    const callback = vi.fn();

    triggers.subscribeConnectivity(callback);

    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('reads current upstream reachability for an already-consumed reconnect edge', async () => {
    await expect(hasUsableInternetConnection()).resolves.toBe(true);
    expect(connectivity.refreshDeviceState).toHaveBeenCalledTimes(1);

    connectivity.publish({ deviceReachability: 'unreachable' });
    await expect(hasUsableInternetConnection()).resolves.toBe(false);
  });

  it('reports a confirmed backend outage as unusable, even on a perfect uplink', async () => {
    connectivity.publish({ effectiveOffline: true, backend: 'unreachable', reason: 'backend_unreachable' });

    await expect(hasUsableInternetConnection()).resolves.toBe(false);
  });

  // The store is the single writer of React Query's online state since #4862. A
  // second writer here could declare the app online moments after the store
  // confirmed the backend down — the exact "looks online, answers nothing" state
  // this work removes.
  it('never writes onlineManager itself', async () => {
    await hasUsableInternetConnection();

    expect(onlineManagerSetOnline).not.toHaveBeenCalled();
  });

  it('binds schema-drift telemetry to Sentry with the offline-sync tags', () => {
    const { options } = startAndGetTriggers();
    options.onSchemaDrift?.({ tableName: 'boardsesh_ticks', column: 'shiny_new_column' });

    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('shiny_new_column') }),
      expect.objectContaining({
        tags: { source: 'offline-sync', kind: 'schema-drift' },
        extra: { tableName: 'boardsesh_ticks', column: 'shiny_new_column' },
      }),
    );
  });
});

describe('snapshot-bootstrap bindings', () => {
  const fakeSnapshotSource = {} as SnapshotSource;

  it('startSyncScheduler passes snapshotSource through only when the caller supplies one', () => {
    const onBootstrapMetadataChanged = vi.fn();
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
      { snapshotSource: fakeSnapshotSource, onBootstrapMetadataChanged },
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    expect(options.snapshotSource).toBe(fakeSnapshotSource);
    expect(options.onBootstrapMetadataChanged).toBe(onBootstrapMetadataChanged);

    vi.clearAllMocks();
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const optionsWithoutSource = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    expect(optionsWithoutSource.snapshotSource).toBeUndefined();
  });

  it('startSyncScheduler always wires the snapshot-bootstrap telemetry handlers', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    expect(options.onSnapshotBootstrapError).toBeTypeOf('function');
    expect(options.onScopeDownloadComplete).toBeTypeOf('function');
    expect(options.onCoverageReset).toBeTypeOf('function');
  });

  it('triggerSync passes snapshotSource through and wires the telemetry handlers', () => {
    const onBootstrapMetadataChanged = vi.fn();
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
      { snapshotSource: fakeSnapshotSource, onBootstrapMetadataChanged },
    );
    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    expect(options.snapshotSource).toBe(fakeSnapshotSource);
    expect(options.onBootstrapMetadataChanged).toBe(onBootstrapMetadataChanged);
    expect(options.onSnapshotBootstrapError).toBeTypeOf('function');
    expect(options.onScopeDownloadComplete).toBeTypeOf('function');
    expect(options.onCoverageReset).toBeTypeOf('function');
  });

  it('reports a bootstrap failure to Sentry with the snapshot-bootstrap tags', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onSnapshotBootstrapError?.({
      scopeKey: 'kilter:1:5',
      stage: 'download',
      attempt: 1,
      cause: null,
      expected: false,
      reason: 'unknown',
      aborted: false,
    });

    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('kilter:1:5') }),
      expect.objectContaining({
        tags: { source: 'offline-sync', kind: 'snapshot-bootstrap', stage: 'download', reason: 'unknown' },
        extra: expect.objectContaining({ scopeKey: 'kilter:1:5', stage: 'download', attempt: 1 }),
      }),
    );
    // A counted failure keeps the caller's default severity — no level override.
    const context = reportHandledError.mock.calls[0][1] as { level?: string };
    expect(context.level).toBeUndefined();
  });

  it('attaches the real cause to the synthetic bootstrap error so the classifier can walk it', () => {
    // The wrapper message ("Snapshot bootstrap failed for …") matches nothing in
    // isNetworkError, so without `{ cause }` every offline user's failure landed
    // at level: error with extra.cause: null (issue #4238).
    const cause = new TypeError('Network request failed');
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onSnapshotBootstrapError?.({
      scopeKey: 'kilter:1:5',
      stage: 'manifest',
      attempt: 0,
      cause,
      expected: true,
      reason: 'network',
      aborted: false,
    });

    const [reported, context] = reportHandledError.mock.calls[0] as [
      Error,
      { level?: string; tags: Record<string, unknown>; extra: Record<string, unknown> },
    ];
    expect(reported.cause).toBe(cause);
    expect(context.level).toBe('warning');
    expect(context.tags).toEqual({
      source: 'offline-sync',
      kind: 'snapshot-bootstrap',
      stage: 'manifest',
      reason: 'network',
      expected_offline: true,
    });
    expect(context.extra).toEqual(
      expect.objectContaining({
        scopeKey: 'kilter:1:5',
        stage: 'manifest',
        attempt: 0,
        expected: true,
        cause: 'Network request failed',
        causeName: 'TypeError',
      }),
    );
  });

  // The abandoned-download terminal's event shape is a permanent analytics
  // contract (issue #4406): reason and stage are enumerated by dashboards, and
  // `aborted: true` is what keeps a Remove tap out of Sentry and out of every
  // failure-rate query. The engine test asserts WHEN the seam fires and the
  // remove-offline-board test asserts it is wired; this pins WHAT it emits.
  it('reports an abandoned download as the funnel Failed shape, and never to Sentry', () => {
    reportScopeDownloadAbandoned({
      scopeKey: 'tension:11:8',
      scope: { boardType: 'tension', layoutId: 11, sizeId: 8 },
    });

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineBoardDownloadFailed,
      expect.objectContaining({
        scopeKey: 'tension:11:8',
        stage: 'board-removed',
        reason: 'abandoned-removed',
        aborted: true,
        expected: true,
        attempt: 0,
      }),
    );
    // A Remove tap is not a defect: `aborted: true` must stop the report at the
    // funnel, or every board removal would land in Sentry as a bootstrap failure.
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  // The de-listing terminals (issue #4452). Same permanent contract as the
  // removal one above, and `stage: 'abandoned'` rather than 'board-removed'
  // deliberately: nothing was removed on these paths, and 'board-removed'
  // already ships in dashboards meaning "the rows were deleted".
  it.each([
    ['sign-out', reportScopeDownloadAbandonedOnSignOut, 'abandoned-signed-out'],
    ['a My Boards toggle-off', reportScopeDownloadAbandonedOnDisable, 'abandoned-disabled'],
  ])('reports a download abandoned by %s as the funnel Failed shape, never to Sentry', (_label, report, reason) => {
    report({ scopeKey: 'tension:11:8' });

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineBoardDownloadFailed,
      expect.objectContaining({
        scopeKey: 'tension:11:8',
        stage: 'abandoned',
        reason,
        aborted: true,
        expected: true,
        attempt: 0,
      }),
    );
    // Signing out and turning a board off are both things the climber chose to
    // do. Neither is a defect, so neither may reach Sentry or a failure rate.
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('captures a PostHog event on scope-download completion with the method + duration', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1234,
      phases: { ...NO_PHASES, downloadMs: 900, importMs: 200, gradesPullMs: 134, gradesRows: 500, artifactBytes: 42 },
    });

    // The phase split rides on the SAME event rather than a new one (#4310).
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1234,
      manifestMs: 0,
      artifactReused: false,
      climbsPullMs: 0,
      statsPullMs: 0,
      gradesPullMs: 134,
      gradesRows: 500,
      offlineEngineEnabled: false,
    });
  });

  it('omits gradesRows when the engine could not count this cycle’s grade rows', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1234,
      phases: { ...NO_PHASES, gradesPullMs: 134 },
    });

    const properties = trackMock.mock.calls[0][1] as Record<string, unknown>;
    // Structural: an explicit `gradesRows: undefined` would read as a value in
    // PostHog, so the key must not be on the object at all.
    expect(Object.hasOwn(properties, 'gradesRows')).toBe(false);
    expect(Object.hasOwn(properties, 'gradesArtifactRows')).toBe(false);
    expect(properties.gradesPullMs).toBe(134);
  });

  it('forwards the grade rows the artifact imported', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1234,
      phases: { ...NO_PHASES, gradesArtifactRows: 41232, gradesRows: 0 },
    });

    const properties = trackMock.mock.calls[0][1] as Record<string, unknown>;
    expect(properties.gradesArtifactRows).toBe(41232);
    // A real measurement here — the artifact left the crawl nothing to fetch.
    expect(properties.gradesRows).toBe(0);
  });

  it('forwards the healed-bootstrap flag so snapshot-vs-paged percentiles can filter on it', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1234,
      bootstrapHealed: true,
      phases: NO_PHASES,
    });
    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:6',
      method: 'paged',
      durationMs: 900,
      phases: NO_PHASES,
    });

    expect((trackMock.mock.calls[0][1] as Record<string, unknown>).bootstrapHealed).toBe(true);
    expect(Object.hasOwn(trackMock.mock.calls[1][1] as Record<string, unknown>, 'bootstrapHealed')).toBe(false);
  });

  it('composes per-scope UI invalidation with completion telemetry', () => {
    const onScopeDownloadComplete = vi.fn();
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
      { onScopeDownloadComplete },
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    const info = { scopeKey: 'kilter:1:5', method: 'paged' as const, durationMs: 500, phases: NO_PHASES };

    options.onScopeDownloadComplete?.(info);

    expect(onScopeDownloadComplete).toHaveBeenCalledWith(info);
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
      scopeKey: 'kilter:1:5',
      method: 'paged',
      durationMs: 500,
      ...NO_PHASE_PROPS,
      offlineEngineEnabled: false,
    });
  });

  it('captures PostHog events for a scheduled snapshot retry and for a recovered board', () => {
    // Operational, not errors: the failure itself already reached Sentry via
    // onSnapshotBootstrapError, and what nobody could answer before #4313 is how
    // often boards give up entirely versus find their way back.
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    const scheduled = {
      scopeKey: 'kilter:1:5',
      boardType: 'kilter',
      stage: 'download' as const,
      failureKind: 'transport' as const,
      retryAfterMs: 120_000,
      transportFailures: 1,
      lockFailures: 0,
      structuralFailures: 0,
      terminal: false,
    };
    const recovered = {
      scopeKey: 'kilter:1:5',
      boardType: 'kilter',
      trigger: 'cooldown' as const,
      hadBoardCheckpoint: true,
    };

    options.onBootstrapRetryScheduled?.(scheduled);
    options.onBootstrapPathRecovered?.(recovered);

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineSnapshotRetryScheduled, scheduled);
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineSnapshotPathRecovered, recovered);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('treats a cellular link as metered and an unreported one as unmetered', async () => {
    // Unknown must read as unmetered: a platform that never reports
    // isConnectionExpensive would otherwise defer every automatic heal forever,
    // leaving the board on the 400+-round-trip crawl with nothing saying why.
    const stopTracking = startBackgroundTracking();
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    netInfoListener?.({ isConnected: true, type: 'cellular' });
    expect(await options.isOnUnmeteredNetwork?.()).toBe(false);
    netInfoListener?.({ isConnected: true, type: 'wifi', details: { isConnectionExpensive: false } });
    expect(await options.isOnUnmeteredNetwork?.()).toBe(true);
    netInfoListener?.({ isConnected: true, type: 'wifi', details: { isConnectionExpensive: true } });
    expect(await options.isOnUnmeteredNetwork?.()).toBe(false);
    netInfoListener?.({ isConnected: true, type: 'wifi' });
    expect(await options.isOnUnmeteredNetwork?.()).toBe(true);

    stopTracking();
  });

  it('reads the link directly on the first cycle, before NetInfo has pushed anything', async () => {
    // The cold-launch race: the scheduler runs its first cycle in the effect
    // right after startBackgroundTracking's, and NetInfo emits asynchronously.
    // Assuming wifi there would start a ~100 MB heal on cellular.
    __resetMeteredStateForTests();
    netInfoFetch.mockResolvedValueOnce({ isConnected: true, type: 'cellular' });
    const stopTracking = startBackgroundTracking();
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    expect(await options.isOnUnmeteredNetwork?.()).toBe(false);
    expect(netInfoFetch).toHaveBeenCalledTimes(1);
    // Seeded: later cycles answer from the cached state, not another fetch.
    expect(await options.isOnUnmeteredNetwork?.()).toBe(false);
    expect(netInfoFetch).toHaveBeenCalledTimes(1);

    stopTracking();
  });

  it('reads an unavailable NetInfo as unmetered rather than deferring the heal forever', async () => {
    __resetMeteredStateForTests();
    netInfoFetch.mockRejectedValueOnce(new Error('NetInfo unavailable'));
    const stopTracking = startBackgroundTracking();
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    expect(await options.isOnUnmeteredNetwork?.()).toBe(true);

    stopTracking();
  });

  // Until #4318 only remove-offline-board.ts ever invalidated these, so a board
  // that finished downloading kept reading as "not downloaded" on every screen
  // the user hadn't left — the badge and every download affordance with it.
  it.each([
    [
      'startSyncScheduler',
      () =>
        startSyncScheduler(
          db,
          queryClient,
          graphqlFetch,
          () => [],
          async () => {},
        ),
    ],
    [
      'triggerSync',
      () =>
        triggerSync(
          db,
          queryClient,
          graphqlFetch,
          () => [],
          async () => {},
        ),
    ],
  ])('refreshes the downloaded-scope caches from %s on scope completion', (name, run) => {
    run();
    const options = (
      name === 'startSyncScheduler' ? startSyncSchedulerCore.mock.calls[0][6] : triggerSyncCore.mock.calls[0][5]
    ) as SchedulerOptions;

    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 10,
      phases: NO_PHASES,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['downloadedScopeKeys'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['offlineStorage'] });
  });

  it('captures a PostHog event — not a Sentry error — when the coverage guard forces a resync', () => {
    // A forced deletions-coverage reset is expected behaviour whose FREQUENCY is
    // the signal (issue #3474), so it belongs with the operational events, not
    // with the handled-error anomalies alongside it in the adapter.
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onCoverageReset?.({ markerAgeDays: 100, rowsCleared: 42, pendingMutations: 3 });

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineSyncCoverageResetForced, {
      markerAgeDays: 100,
      rowsCleared: 42,
      pendingMutations: 3,
    });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  // Issue #4315. The engine reports the verdict on EVERY cycle so the seam stays
  // deterministic; the dedupe lives here because enforceDeletionsCoverage runs
  // at the top of every pullSync and the scheduler wakes on foreground and
  // reconnect with no interval — a device stuck on `unknown` would otherwise
  // emit forever, and those are exactly the devices worth counting once.
  it('reports the coverage verdict to analytics, deduped per verdict for the launch', () => {
    __resetCoverageVerdictDedupeForTests();
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    options.onCoverageEvaluated?.({ verdict: 'unknown', markerAgeDays: null, outcome: 'evaluated' });
    options.onCoverageEvaluated?.({ verdict: 'unknown', markerAgeDays: null, outcome: 'evaluated' });

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineSyncCoverageEvaluated, {
      verdict: 'unknown',
      markerAgeDays: null,
      outcome: 'evaluated',
    });
    // Never Sentry: an evaluation is not a failure, even when it is `stale`.
    expect(reportHandledError).not.toHaveBeenCalled();

    // A changed verdict is new information and reports again.
    options.onCoverageEvaluated?.({ verdict: 'stale', markerAgeDays: 100, outcome: 'evaluated' });
    options.onCoverageEvaluated?.({ verdict: 'stale', markerAgeDays: 100, outcome: 'reset' });
    expect(trackMock).toHaveBeenCalledTimes(3);
  });

  it('fires the funnel Started event with the persisted trigger, then prunes it', () => {
    rememberDownloadTrigger('kilter:1:5', 'download-all');
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    options.onScopeDownloadStart?.({ scopeKey: 'kilter:1:5', pathIntent: 'snapshot', artifactBytes: 103_000_000 });

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadStarted, {
      scopeKey: 'kilter:1:5',
      pathIntent: 'snapshot',
      artifactBytes: 103_000_000,
      trigger: 'download-all',
      offlineEngineEnabled: false,
    });

    // Consumed: a second Started for the same scope (which the engine's durable
    // marker should prevent anyway) can't re-use a stale attribution.
    trackMock.mockClear();
    options.onScopeDownloadStart?.({ scopeKey: 'kilter:1:5', pathIntent: 'paged', artifactBytes: null });
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineBoardDownloadStarted,
      expect.objectContaining({ trigger: 'unknown' }),
    );
  });

  it('reports trigger "unknown" for a scope enabled by a build that predates the attribution', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    options.onScopeDownloadStart?.({ scopeKey: 'tension:2:10', pathIntent: 'paged', artifactBytes: null });

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineBoardDownloadStarted,
      expect.objectContaining({ trigger: 'unknown', artifactBytes: null }),
    );
  });

  it('sends a bootstrap failure to BOTH the funnel and Sentry, keeping the expected-offline downgrade', () => {
    // Sentry alone can't answer "what fraction of downloads fail, and where" —
    // it groups by exception shape and deliberately downgrades transport
    // failures. Same call site, so the two can never disagree.
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    options.onSnapshotBootstrapError?.({
      scopeKey: 'kilter:1:5',
      stage: 'download',
      attempt: 2,
      cause: new Error('The request timed out.'),
      expected: true,
      reason: 'network',
      aborted: false,
    });

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadFailed, {
      scopeKey: 'kilter:1:5',
      stage: 'download',
      attempt: 2,
      expected: true,
      reason: 'network',
      aborted: false,
      errorMessage: 'The request timed out.',
      offlineEngineEnabled: false,
    });
    expect(reportHandledError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ level: 'warning' }));
  });

  it('keeps a torn-down download in the funnel and out of Sentry', () => {
    // A board removal, a sign-out, or a pocketed phone. These used to emit
    // NOTHING, leaving a Started with no terminal event (issue #4314) — so the
    // funnel gets them, tagged `aborted: true` for the rate query to exclude.
    // Sentry does not: there are as many of these as there are lock screens, and
    // they would bury the artifact and database failures worth reading.
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    options.onSnapshotBootstrapError?.({
      scopeKey: 'kilter:1:5',
      stage: 'download',
      attempt: 0,
      cause: null,
      expected: true,
      reason: 'aborted-wipe',
      aborted: true,
    });

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadFailed, {
      scopeKey: 'kilter:1:5',
      stage: 'download',
      attempt: 0,
      expected: true,
      reason: 'aborted-wipe',
      aborted: true,
      errorMessage: 'null',
      offlineEngineEnabled: false,
    });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('tags a real failure with its stage and reason so Sentry can group on them', () => {
    // Tags, not extras: Sentry only searches and groups on tags, and chasing
    // BOARDSESH-D7 through `extra.stage` is what made "which phase is this?"
    // unanswerable from the issue page.
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    options.onSnapshotBootstrapError?.({
      scopeKey: 'kilter:1:5',
      stage: 'import',
      attempt: 1,
      cause: new Error('Error code 6: database table is locked'),
      expected: false,
      reason: 'database-locked',
      aborted: false,
    });

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineBoardDownloadFailed,
      expect.objectContaining({ reason: 'database-locked', aborted: false }),
    );
    const context = reportHandledError.mock.calls[0][1] as { tags: Record<string, unknown> };
    expect(context.tags).toEqual({
      source: 'offline-sync',
      kind: 'snapshot-bootstrap',
      stage: 'import',
      reason: 'database-locked',
    });
  });

  it('carries the payload props on Completed, and omits them when the import ran in an earlier cycle', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;

    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1000,
      bytes: 103_000_000,
      rowCount: 40_000,
      downloadMs: 800,
      importMs: 150,
      phases: NO_PHASES,
    });
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1000,
      bytes: 103_000_000,
      rowCount: 40_000,
      downloadMs: 800,
      importMs: 150,
      ...NO_PHASE_PROPS,
      offlineEngineEnabled: false,
    });

    // A cross-cycle completion: absent, never zero — a 0 would read as a real
    // measurement of a download that took no time.
    trackMock.mockClear();
    options.onScopeDownloadComplete?.({
      scopeKey: 'kilter:1:6',
      method: 'snapshot',
      durationMs: 2000,
      phases: NO_PHASES,
    });
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
      scopeKey: 'kilter:1:6',
      method: 'snapshot',
      durationMs: 2000,
      ...NO_PHASE_PROPS,
      offlineEngineEnabled: false,
    });
  });

  it('pullSync binds the snapshot-bootstrap telemetry defaults but lets caller options win', async () => {
    const customBootstrapError = vi.fn();
    await pullSync(db, queryClient, graphqlFetch, { onSnapshotBootstrapError: customBootstrapError });

    const options = pullSyncCore.mock.calls[0][3] as SyncOptions;
    options.onSnapshotBootstrapError?.({
      scopeKey: 'kilter:1:5',
      stage: 'manifest',
      attempt: 1,
      cause: null,
      expected: false,
      reason: 'unknown',
      aborted: false,
    });
    expect(customBootstrapError).toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();

    options.onScopeDownloadComplete?.({ scopeKey: 'kilter:1:5', method: 'paged', durationMs: 500, phases: NO_PHASES });
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
      scopeKey: 'kilter:1:5',
      method: 'paged',
      durationMs: 500,
      ...NO_PHASE_PROPS,
      offlineEngineEnabled: false,
    });

    // The Started reporter is bound by default too.
    options.onScopeDownloadStart?.({ scopeKey: 'kilter:1:5', pathIntent: 'paged', artifactBytes: null });
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineBoardDownloadStarted,
      expect.objectContaining({ scopeKey: 'kilter:1:5', pathIntent: 'paged' }),
    );
  });
});

describe('connectivity probe on the pull path (issue #4238)', () => {
  it('startSyncScheduler hands the scheduler the onlineManager-backed probe', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );

    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    onlineManagerIsOnline.mockReturnValue(true);
    expect(options.isOnline?.()).toBe(true);
    onlineManagerIsOnline.mockReturnValue(false);
    expect(options.isOnline?.()).toBe(false);
  });

  it('triggerSync hands the scheduler the same probe', () => {
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );

    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    onlineManagerIsOnline.mockReturnValue(false);
    expect(options.isOnline?.()).toBe(false);
  });

  it('pullSync defaults to the probe and lets a caller-supplied one win', async () => {
    await pullSync(db, queryClient, graphqlFetch);
    const defaulted = pullSyncCore.mock.calls[0][3] as SyncOptions;
    onlineManagerIsOnline.mockReturnValue(false);
    expect(defaulted.isOnline?.()).toBe(false);

    vi.clearAllMocks();
    const customProbe = vi.fn(() => true);
    await pullSync(db, queryClient, graphqlFetch, { isOnline: customProbe });
    const overridden = pullSyncCore.mock.calls[0][3] as SyncOptions;
    expect(overridden.isOnline?.()).toBe(true);
    expect(customProbe).toHaveBeenCalled();
    expect(onlineManagerIsOnline).not.toHaveBeenCalled();
  });
});

describe('triggerSync / pullSync bindings', () => {
  it('triggerSync forwards the progress sink alongside the bound telemetry options', () => {
    const onProgress = vi.fn();
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => ['kilter:1:5'],
      async () => {},
      { onProgress },
    );

    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    expect(options.onProgress).toBe(onProgress);
    expect(options.onSchemaDrift).toBeTypeOf('function');
    expect(options.onCycleError).toBeTypeOf('function');
  });

  it('reports the last visible phase when a cycle fails after snapshot transfers', () => {
    setSyncProgress({ phase: 'deletions', currentTable: null, documentsProcessed: 500 });
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => ['soill:1:1'],
      async () => {},
    );

    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    const cycleError = new Error('database write failed at /private/device/offline.db');
    options.onCycleError?.(cycleError);

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineSyncCycleFailed, {
      phase: 'deletions',
      currentTable: null,
      documentsProcessed: 500,
      expected: false,
      status: null,
      errorKind: 'exception',
      offlineEngineEnabled: false,
    });
    expect(reportHandledError).toHaveBeenCalledWith(cycleError, {
      tags: { source: 'offline-sync', kind: 'cycle', phase: 'deletions' },
      extra: { currentTable: null, documentsProcessed: 500 },
    });
  });

  it('tracks an expected request timeout without sending routine reachability failures to Sentry', () => {
    setSyncProgress({ phase: 'board_data', currentTable: 'board_climb_stats:kilter:1:10', documentsProcessed: 42 });
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => ['kilter:1:10'],
      async () => {},
    );

    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    const timeoutError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    options.onCycleError?.(timeoutError);

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineSyncCycleFailed,
      expect.objectContaining({
        phase: 'board_data',
        currentTable: 'board_climb_stats:kilter:1:10',
        expected: true,
        errorKind: 'aborted',
      }),
    );
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  // Before #4862 these landed in `server` or `exception`, next to real defects,
  // so a nine-minute outage read as a spike of sync bugs.
  it('buckets a cycle that failed while the backend was confirmed down as server_unavailable', () => {
    connectivity.publish({ effectiveOffline: true, backend: 'unreachable', reason: 'backend_unreachable' });
    setSyncProgress({ phase: 'board_data', currentTable: 'boardsesh_climbs', documentsProcessed: 7 });
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => ['kilter:1:10'],
      async () => {},
    );

    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    options.onCycleError?.(new Error('pull failed'));

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineSyncCycleFailed,
      expect.objectContaining({ errorKind: 'server_unavailable' }),
    );
  });

  // A user-cancelled teardown still reads as aborted: an outage in the
  // background must not relabel every interrupted cycle.
  it('keeps aborted ahead of server_unavailable', () => {
    connectivity.publish({ effectiveOffline: true, backend: 'unreachable', reason: 'backend_unreachable' });
    setSyncProgress({ phase: 'board_data', currentTable: null, documentsProcessed: 0 });
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => ['kilter:1:10'],
      async () => {},
    );

    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    options.onCycleError?.(Object.assign(new Error('torn down'), { name: 'AbortError' }));

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineSyncCycleFailed,
      expect.objectContaining({ errorKind: 'aborted' }),
    );
  });

  it('deduplicates a repeating expected cycle failure for five minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
    try {
      setSyncProgress({ phase: 'deletions', currentTable: null, documentsProcessed: 0 });
      triggerSync(
        db,
        queryClient,
        graphqlFetch,
        () => ['soill:1:1'],
        async () => {},
      );
      const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
      const timeoutError = Object.assign(new Error('private request text'), { name: 'AbortError' });

      options.onCycleError?.(timeoutError);
      options.onCycleError?.(timeoutError);
      vi.advanceTimersByTime(299_999);
      options.onCycleError?.(timeoutError);
      expect(trackMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      options.onCycleError?.(timeoutError);
      expect(trackMock).toHaveBeenCalledTimes(2);
      for (const [, properties] of trackMock.mock.calls as [string, Record<string, unknown>][]) {
        expect(properties).not.toHaveProperty('error');
        expect(properties).not.toHaveProperty('errorMessage');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates repeating unexpected failures but reports a changed phase immediately', () => {
    setSyncProgress({ phase: 'deletions', currentTable: null, documentsProcessed: 0 });
    triggerSync(
      db,
      queryClient,
      graphqlFetch,
      () => ['soill:1:1'],
      async () => {},
    );
    const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
    const sqliteError = new Error('database is locked');

    options.onCycleError?.(sqliteError);
    options.onCycleError?.(sqliteError);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(reportHandledError).toHaveBeenCalledTimes(1);

    setSyncProgress({ phase: 'user_data', currentTable: 'boardsesh_ticks', documentsProcessed: 0 });
    options.onCycleError?.(sqliteError);
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(reportHandledError).toHaveBeenCalledTimes(2);
  });

  it('does not suppress cycle telemetry when the wall clock moves backwards', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T01:00:00.000Z'));
    try {
      setSyncProgress({ phase: 'deletions', currentTable: null, documentsProcessed: 0 });
      triggerSync(
        db,
        queryClient,
        graphqlFetch,
        () => ['soill:1:1'],
        async () => {},
      );
      const options = triggerSyncCore.mock.calls[0][5] as SchedulerOptions;
      const timeoutError = Object.assign(new Error('timeout'), { name: 'AbortError' });

      options.onCycleError?.(timeoutError);
      vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
      options.onCycleError?.(timeoutError);

      expect(trackMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pullSync binds schema-drift telemetry but lets caller options win', async () => {
    const customDrift = vi.fn();
    await pullSync(db, queryClient, graphqlFetch, { onSchemaDrift: customDrift });

    const options = pullSyncCore.mock.calls[0][3] as SyncOptions;
    options.onSchemaDrift?.({ tableName: 't', column: 'c' });
    expect(customDrift).toHaveBeenCalledWith({ tableName: 't', column: 'c' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
