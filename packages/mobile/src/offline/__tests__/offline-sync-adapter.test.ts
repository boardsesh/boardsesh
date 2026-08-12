// The adapter is the ONE place the platform seams get bound — every other suite
// mocks it out, so this file is what actually proves the bindings: the drain
// always carries the onlineManager-backed connectivity probe, the scheduler
// triggers translate AppState/NetInfo events, and schema drift reaches Sentry.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const onlineManagerIsOnline = vi.fn(() => true);
vi.mock('@tanstack/react-query', () => ({
  onlineManager: { isOnline: () => onlineManagerIsOnline() },
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

type NetInfoListener = (state: { isConnected: boolean | null }) => void;
let netInfoListener: NetInfoListener | null = null;
const netInfoUnsubscribe = vi.fn();
vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: (listener: NetInfoListener) => {
      netInfoListener = listener;
      return netInfoUnsubscribe;
    },
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

const reportHandledError = vi.fn();
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => reportHandledError(...args),
}));

const trackMock = vi.fn();
vi.mock('../../lib/analytics', () => ({ track: (...args: unknown[]) => trackMock(...args) }));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  drainMutationQueue,
  startSyncScheduler,
  triggerSync,
  pullSync,
  startBackgroundTracking,
  subscribeMutationDelivery,
  __resetCoverageVerdictDedupeForTests,
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

const db = {} as OfflineDatabase;
const queryClient = { invalidateQueries: vi.fn() } as unknown as import('@tanstack/react-query').QueryClient;
const graphqlFetch = vi.fn() as unknown as import('@boardsesh/offline-sync').GraphQLFetch;

beforeEach(() => {
  vi.clearAllMocks();
  appStateListener = null;
  netInfoListener = null;
  onlineManagerIsOnline.mockReturnValue(true);
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

  it('connectivity trigger forwards NetInfo state, mapping null to false, and unsubscribes', () => {
    const { triggers } = startAndGetTriggers();
    const callback = vi.fn();
    const unsubscribe = triggers.subscribeConnectivity(callback);

    netInfoListener?.({ isConnected: true });
    netInfoListener?.({ isConnected: null });
    expect(callback).toHaveBeenNthCalledWith(1, true);
    expect(callback).toHaveBeenNthCalledWith(2, false);

    unsubscribe();
    expect(netInfoUnsubscribe).toHaveBeenCalledTimes(1);
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
    });

    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('kilter:1:5') }),
      expect.objectContaining({
        tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' },
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
    });

    const [reported, context] = reportHandledError.mock.calls[0] as [
      Error,
      { level?: string; tags: Record<string, unknown>; extra: Record<string, unknown> },
    ];
    expect(reported.cause).toBe(cause);
    expect(context.level).toBe('warning');
    expect(context.tags).toEqual({ source: 'offline-sync', kind: 'snapshot-bootstrap', expected_offline: true });
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

  it('captures a PostHog event on scope-download completion with the method + duration', () => {
    startSyncScheduler(
      db,
      queryClient,
      graphqlFetch,
      () => [],
      async () => {},
    );
    const options = startSyncSchedulerCore.mock.calls[0][6] as SchedulerOptions;
    options.onScopeDownloadComplete?.({ scopeKey: 'kilter:1:5', method: 'snapshot', durationMs: 1234 });

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
      scopeKey: 'kilter:1:5',
      method: 'snapshot',
      durationMs: 1234,
    });
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
    const info = { scopeKey: 'kilter:1:5', method: 'paged' as const, durationMs: 500 };

    options.onScopeDownloadComplete?.(info);

    expect(onScopeDownloadComplete).toHaveBeenCalledWith(info);
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, info);
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
    });
    expect(customBootstrapError).toHaveBeenCalled();
    expect(reportHandledError).not.toHaveBeenCalled();

    options.onScopeDownloadComplete?.({ scopeKey: 'kilter:1:5', method: 'paged', durationMs: 500 });
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineBoardDownloadCompleted, {
      scopeKey: 'kilter:1:5',
      method: 'paged',
      durationMs: 500,
    });
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

  it('pullSync binds schema-drift telemetry but lets caller options win', async () => {
    const customDrift = vi.fn();
    await pullSync(db, queryClient, graphqlFetch, { onSchemaDrift: customDrift });

    const options = pullSyncCore.mock.calls[0][3] as SyncOptions;
    options.onSchemaDrift?.({ tableName: 't', column: 'c' });
    expect(customDrift).toHaveBeenCalledWith({ tableName: 't', column: 'c' });
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
