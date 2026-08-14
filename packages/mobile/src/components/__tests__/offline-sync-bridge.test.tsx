// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The analytics barrel reaches posthog-react-native; stub it so the module scan
// never parses it. The two flag readers are what FeatureFlagsProvider itself
// imports from here.
vi.mock('../../lib/analytics', () => ({
  readPosthogFeatureFlags: () => ({}),
  subscribePosthogFeatureFlags: () => () => {},
}));

// Same reason (it reaches the PostHog client), plus it makes the registered
// engine state assertable.
const registerOfflineEngineStateMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics-offline-engine-state', () => ({
  registerOfflineEngineState: (state: string) => registerOfflineEngineStateMock(state),
}));

// The bridge is the flag boundary of the offline engine: scheduler only when
// `offline-board-downloads` is on, a one-shot leftover drain when it's off
// (queued writes must never strand), notifications always.

const startSyncSchedulerStop = vi.fn();
const startSyncSchedulerMock = vi.fn(() => startSyncSchedulerStop);
const notifyBootstrapMetadataChangedMock = vi.hoisted(() => vi.fn());
const notifyScopeDownloadCompleteMock = vi.hoisted(() => vi.fn());
vi.mock('../../sync', () => ({
  setSyncProgress: vi.fn(),
  notifyBootstrapMetadataChanged: (info: unknown) => notifyBootstrapMetadataChangedMock(info),
  notifyScopeDownloadComplete: (info: unknown) => notifyScopeDownloadCompleteMock(info),
}));

const drainMutationQueueMock = vi.fn(async (..._args: unknown[]) => {});
const startBackgroundTrackingStop = vi.fn();
const startBackgroundTrackingMock = vi.fn(() => startBackgroundTrackingStop);
// The scheduler + drain bindings live in the adapter (which statically imports
// react-native — mock it so Rolldown's scan never parses the RN Flow entry).
vi.mock('../../offline/offline-sync-adapter', () => ({
  startSyncScheduler: (...args: unknown[]) => startSyncSchedulerMock(...(args as [])),
  drainMutationQueue: (...args: unknown[]) => drainMutationQueueMock(...args),
  startBackgroundTracking: () => startBackgroundTrackingMock(),
}));

// A stable sentinel so tests can assert the bridge passes THIS reference
// through to startSyncScheduler (rather than exercising the real
// expo-file-system-backed implementation). vi.hoisted because vi.mock
// factories are hoisted above regular top-level const declarations.
const mobileSnapshotSourceStub = vi.hoisted(() => ({ tag: 'snapshot-source' }));
const setSnapshotDownloadStrategyFromFlagsMock = vi.hoisted(() => vi.fn());
vi.mock('../../offline/snapshot-source', () => ({
  mobileSnapshotSource: mobileSnapshotSourceStub,
  setSnapshotDownloadStrategyFromFlags: (flags: unknown) => setSnapshotDownloadStrategyFromFlagsMock(flags),
}));

const getPendingCountMock = vi.fn(async (..._args: unknown[]) => 0);
// Owner-stamp plumbing: the bridge is where the device learns whose user-data
// rows it holds, so a wrong-account stamp has to trigger the wipe from here.
const assertLocalUserDataOwnerMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'ok'));
const stampLocalUserIdMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const clearUserDataMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const beginLocalPurgeMock = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/offline-sync', () => ({
  getPendingCount: (...args: unknown[]) => getPendingCountMock(...args),
  assertLocalUserDataOwner: (...args: unknown[]) => assertLocalUserDataOwnerMock(...args),
  stampLocalUserId: (...args: unknown[]) => stampLocalUserIdMock(...args),
  beginLocalPurge: (...args: unknown[]) => beginLocalPurgeMock(...args),
}));

// db/connection statically reaches expo-sqlite + the error reporter; the bridge
// only needs the wipe callback, so stub the module rather than the world.
vi.mock('../../db/connection', () => ({
  clearUserData: (...args: unknown[]) => clearUserDataMock(...args),
}));

// use-current-user-id reads the JWT out of SecureStore via lib/auth-store, whose
// react-native Flow entry breaks Rolldown's collection-time scan.
vi.mock('../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: storedUserId, isLoading: false }),
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: vi.fn(),
}));

// The gauge itself is unit-tested in offline/__tests__/outbox-telemetry.test.ts;
// what matters here is WHERE the bridge calls it from — both flag branches, once.
const reportOutboxBacklogOnceMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../../offline/outbox-telemetry', () => ({
  reportOutboxBacklogOnce: reportOutboxBacklogOnceMock,
}));

// Stub the settings barrel so the static import graph never pulls
// react-native-mmkv (its react-native Flow entry breaks Rolldown's scan).
vi.mock('../../settings', () => ({
  getSetting: vi.fn(() => []),
}));

const setupNotificationHandlersMock = vi.fn(() => vi.fn());
vi.mock('../../notifications', () => ({
  setupNotificationHandlers: (...args: unknown[]) => setupNotificationHandlersMock(...(args as [])),
}));

vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: vi.fn() }),
}));

const snapshotBaseUrlConfigured = vi.hoisted(() => ({ value: true }));
vi.mock('../../lib/env', () => ({
  isSnapshotBaseUrlConfigured: () => snapshotBaseUrlConfigured.value,
}));

const fakeDb = { tag: 'db' };
vi.mock('expo-sqlite', () => ({
  useSQLiteContext: () => fakeDb,
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn(), navigate: vi.fn() },
}));

// The bridge gates its sync effect on auth itself (it is mounted outside any
// auth-gated subtree). Mutable so the signed-out test can flip it.
let isAuthenticated = true;
let storedUserId: string | undefined = 'user-1';
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated }),
}));

// feature-flag-overrides persists through AsyncStorage; give it an in-memory stub.
vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

import { OfflineSyncBridge, OfflineEngineFlagSync, FLAG_SETTLE_MS } from '../offline-sync-bridge';
import { FeatureFlagsProvider, type FeatureFlags } from '../../providers/feature-flags-provider';
import { isOfflineEngineEnabled, __resetOfflineEngineForTests } from '../../lib/offline-engine';
import { setSchemaReady, __resetSchemaReadyForTests } from '../../db/schema-ready';

function Harness({ flags, queryClient }: { flags: FeatureFlags; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <FeatureFlagsProvider flags={flags}>
        <OfflineEngineFlagSync />
        <OfflineSyncBridge />
      </FeatureFlagsProvider>
    </QueryClientProvider>
  );
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Just the flag-sync component — no scheduler, no async drain — so the
// measurement tests can run under fake timers without racing the bridge.
function FlagSyncHarness({ flags }: { flags: FeatureFlags }) {
  return (
    <FeatureFlagsProvider flags={flags}>
      <OfflineEngineFlagSync />
    </FeatureFlagsProvider>
  );
}

const FLAG_ON: FeatureFlags = { 'offline-board-downloads': true };
const FLAG_OFF: FeatureFlags = { 'offline-board-downloads': false };
// PostHog never resolved — the #4312 cohort. Since the bake this reads as ON.
const FLAG_UNSET: FeatureFlags = {};
const FLAG_ON_WITH_SNAPSHOT: FeatureFlags = {
  'offline-board-downloads': true,
  'offline-snapshot-bootstrap-v2': true,
};
function getStartSyncSchedulerSnapshotSource(): unknown {
  const call = startSyncSchedulerMock.mock.calls[0] as unknown[] | undefined;
  expect(call).toBeDefined();
  // The trailing argument is the named options bag — no positional offsets to
  // silently drift if the scheduler signature grows.
  const options = call?.at(-1) as { snapshotSource?: unknown } | undefined;
  return options?.snapshotSource;
}

function getStartSyncSchedulerOptions(): {
  snapshotSource?: unknown;
  onBootstrapMetadataChanged?: (info: unknown) => void;
  onScopeDownloadComplete?: (info: unknown) => void;
} {
  const call = startSyncSchedulerMock.mock.calls[0] as unknown[] | undefined;
  expect(call).toBeDefined();
  return (call?.at(-1) ?? {}) as {
    snapshotSource?: unknown;
    onBootstrapMetadataChanged?: (info: unknown) => void;
    onScopeDownloadComplete?: (info: unknown) => void;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  startSyncSchedulerMock.mockReturnValue(startSyncSchedulerStop);
  getPendingCountMock.mockResolvedValue(0);
  isAuthenticated = true;
  storedUserId = 'user-1';
  assertLocalUserDataOwnerMock.mockClear();
  assertLocalUserDataOwnerMock.mockResolvedValue('ok');
  stampLocalUserIdMock.mockClear();
  clearUserDataMock.mockClear();
  beginLocalPurgeMock.mockClear();
  snapshotBaseUrlConfigured.value = true;
  // Every case below except the readiness-gating describe assumes the ordinary
  // uncontended launch, where the schema is stamped before the first render.
  setSchemaReady(true);
});

afterEach(() => {
  __resetOfflineEngineForTests();
  __resetSchemaReadyForTests();
});

// The bridge owns the "whose rows are these?" stamp, which is the only defence
// that survives a sign-out wipe that did not finish (a locked database — #4314 —
// or a crash mid-sign-out). Without it, every user-scoped local read on the next
// account reads the previous climber's data.
describe('OfflineSyncBridge — local user-data owner stamp', () => {
  it('claims a never-stamped device for the signed-in climber', async () => {
    assertLocalUserDataOwnerMock.mockResolvedValue('unstamped');
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(stampLocalUserIdMock).toHaveBeenCalledTimes(1));
    expect(stampLocalUserIdMock.mock.calls[0][1]).toBe('user-1');
    expect(clearUserDataMock).not.toHaveBeenCalled();
  });

  it('wipes and re-stamps when the rows belong to another account', async () => {
    assertLocalUserDataOwnerMock.mockResolvedValue('mismatch');
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(clearUserDataMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(stampLocalUserIdMock).toHaveBeenCalledTimes(1));
    expect(stampLocalUserIdMock.mock.calls[0][1]).toBe('user-1');
    // The epoch bump must land BEFORE the wipe: a pull page already on the wire
    // when clearUserData ran would otherwise land afterwards and resurrect rows
    // with a checkpoint past them — a gap `user_data_complete` would then
    // falsely vouch for.
    expect(beginLocalPurgeMock).toHaveBeenCalledTimes(1);
    expect(beginLocalPurgeMock.mock.invocationCallOrder[0]).toBeLessThan(clearUserDataMock.mock.invocationCallOrder[0]);
  });

  it('leaves a matching stamp alone', async () => {
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(assertLocalUserDataOwnerMock).toHaveBeenCalled());
    expect(stampLocalUserIdMock).not.toHaveBeenCalled();
    expect(clearUserDataMock).not.toHaveBeenCalled();
  });

  it('stamps nothing while signed out — an unowned device must not claim an owner', async () => {
    isAuthenticated = false;
    storedUserId = undefined;
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalled());
    expect(assertLocalUserDataOwnerMock).not.toHaveBeenCalled();
    expect(stampLocalUserIdMock).not.toHaveBeenCalled();
  });

  it('runs regardless of the offline-downloads flag — the stamp guards reads, not downloads', async () => {
    assertLocalUserDataOwnerMock.mockResolvedValue('unstamped');
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(stampLocalUserIdMock).toHaveBeenCalledTimes(1));
  });
});

describe('OfflineSyncBridge — flag ON', () => {
  it('starts the sync scheduler and skips the leftover drain', async () => {
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    expect(getPendingCountMock).not.toHaveBeenCalled();
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });

  it('sets up notification handlers', async () => {
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
  });

  it('stops the scheduler on unmount', async () => {
    const { unmount } = render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalled());
    unmount();
    expect(startSyncSchedulerStop).toHaveBeenCalledTimes(1);
  });

  it('starts background tracking on mount and tears it down on unmount', async () => {
    const { unmount } = render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startBackgroundTrackingMock).toHaveBeenCalledTimes(1));
    expect(startBackgroundTrackingStop).not.toHaveBeenCalled();
    unmount();
    expect(startBackgroundTrackingStop).toHaveBeenCalledTimes(1);
  });

  it('passes no snapshotSource when offline-snapshot-bootstrap is off', async () => {
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    expect(getStartSyncSchedulerSnapshotSource()).toBeUndefined();
  });

  it('passes the mobile snapshot source when offline-snapshot-bootstrap is also on', async () => {
    render(<Harness flags={FLAG_ON_WITH_SNAPSHOT} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    expect(getStartSyncSchedulerSnapshotSource()).toBe(mobileSnapshotSourceStub);
  });

  it('pushes the resolved transport flags into the source WITHOUT churning its identity', async () => {
    // Issue #4394. The source's object identity is a dependency of the
    // scheduler effect, so a flag resolving mid-download must not rebuild it —
    // which is exactly why the strategy rides module state instead of the memo.
    render(
      <Harness
        flags={{ ...FLAG_ON_WITH_SNAPSHOT, 'offline-download-task-api': true }}
        queryClient={makeQueryClient()}
      />,
    );
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));

    expect(setSnapshotDownloadStrategyFromFlagsMock).toHaveBeenCalledWith({
      taskApiFlag: true,
      backgroundSessionFlag: undefined,
    });
    expect(getStartSyncSchedulerSnapshotSource()).toBe(mobileSnapshotSourceStub);
  });

  it('publishes each scope metadata settlement before the rest of a multi-scope bootstrap finishes', async () => {
    render(<Harness flags={FLAG_ON_WITH_SNAPSHOT} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));

    const info = { scopeKey: 'kilter:1:5' };
    getStartSyncSchedulerOptions().onBootstrapMetadataChanged?.(info);

    expect(notifyBootstrapMetadataChangedMock).toHaveBeenCalledWith(info);
  });

  it('publishes each scope completion before the rest of a multi-scope cycle finishes', async () => {
    render(<Harness flags={FLAG_ON_WITH_SNAPSHOT} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));

    const info = { scopeKey: 'kilter:1:5' };
    getStartSyncSchedulerOptions().onScopeDownloadComplete?.(info);

    expect(notifyScopeDownloadCompleteMock).toHaveBeenCalledWith(info);
  });

  it('passes no snapshotSource when the snapshot manifest URL is not configured', async () => {
    snapshotBaseUrlConfigured.value = false;

    render(<Harness flags={FLAG_ON_WITH_SNAPSHOT} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    expect(getStartSyncSchedulerSnapshotSource()).toBeUndefined();
  });
});

describe('OfflineSyncBridge — flag OFF', () => {
  it('never starts the scheduler; with an empty queue it does not drain', async () => {
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(getPendingCountMock).toHaveBeenCalledTimes(1));
    expect(startSyncSchedulerMock).not.toHaveBeenCalled();
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });

  it('drains leftover queued writes exactly once (the non-stranding rule)', async () => {
    getPendingCountMock.mockResolvedValue(3);
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(drainMutationQueueMock).toHaveBeenCalledTimes(1));
    expect(startSyncSchedulerMock).not.toHaveBeenCalled();
  });

  it('still sets up notification handlers (notifications are not flag-gated)', async () => {
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
  });

  it('still starts background tracking (not flag-gated — covers the leftover drain too) and tears it down on unmount', async () => {
    const { unmount } = render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startBackgroundTrackingMock).toHaveBeenCalledTimes(1));
    expect(startBackgroundTrackingStop).not.toHaveBeenCalled();
    unmount();
    expect(startBackgroundTrackingStop).toHaveBeenCalledTimes(1);
  });
});

describe('OfflineSyncBridge — auth gating', () => {
  it('signed out: no scheduler, no leftover drain, no sync traffic at all', async () => {
    isAuthenticated = false;
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    // Notifications and background tracking still set up — they are
    // auth-independent effects.
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
    expect(startBackgroundTrackingMock).toHaveBeenCalledTimes(1);
    expect(startSyncSchedulerMock).not.toHaveBeenCalled();
    expect(getPendingCountMock).not.toHaveBeenCalled();
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });
});

describe('OfflineSyncBridge — mid-session flag flips', () => {
  it('ON→OFF stops the scheduler and invalidates the local-first read caches', async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = render(<Harness flags={FLAG_ON} queryClient={queryClient} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));

    rerender(<Harness flags={FLAG_OFF} queryClient={queryClient} />);

    await waitFor(() => expect(startSyncSchedulerStop).toHaveBeenCalledTimes(1));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['infiniteSearchClimbs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['searchClimbsCount'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['climb'] });
  });

  it('OFF→ON starts the scheduler without invalidating anything', async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = render(<Harness flags={FLAG_OFF} queryClient={queryClient} />);
    await waitFor(() => expect(getPendingCountMock).toHaveBeenCalled());

    rerender(<Harness flags={FLAG_ON} queryClient={queryClient} />);

    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// Issue #4315: a kill-switched user's queued writes are exactly as stranded as a
// flag-on user's — and sign-out deletes them all — so the launch gauge has to
// run on both sides of the flag, and never on a signed-out launch.
describe('OfflineSyncBridge — outbox backlog gauge', () => {
  it('reads the backlog once with the flag ON', async () => {
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);

    await waitFor(() => expect(reportOutboxBacklogOnceMock).toHaveBeenCalledTimes(1));
    expect(reportOutboxBacklogOnceMock).toHaveBeenCalledWith(fakeDb);
  });

  it('reads the backlog with the flag OFF too', async () => {
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);

    await waitFor(() => expect(reportOutboxBacklogOnceMock).toHaveBeenCalledTimes(1));
  });

  it('does not read anything while signed out', async () => {
    isAuthenticated = false;
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);

    await waitFor(() => expect(startBackgroundTrackingMock).toHaveBeenCalled());
    expect(reportOutboxBacklogOnceMock).not.toHaveBeenCalled();
  });

  it('does not re-read when the flag flips mid-session', async () => {
    const queryClient = makeQueryClient();
    const { rerender } = render(<Harness flags={FLAG_ON} queryClient={queryClient} />);
    await waitFor(() => expect(reportOutboxBacklogOnceMock).toHaveBeenCalledTimes(1));

    rerender(<Harness flags={FLAG_OFF} queryClient={queryClient} />);
    await waitFor(() => expect(getPendingCountMock).toHaveBeenCalled());

    expect(reportOutboxBacklogOnceMock).toHaveBeenCalledTimes(1);
  });

  it('waits for a stamped schema before reading the outbox', async () => {
    // Same hazard as the sync effect: on a contended launch pending_mutations
    // does not exist yet, and a gauge that throws there reports no backlog at
    // all rather than the backlog it could not read.
    setSchemaReady(false);
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
    expect(reportOutboxBacklogOnceMock).not.toHaveBeenCalled();

    act(() => setSchemaReady(true));

    await waitFor(() => expect(reportOutboxBacklogOnceMock).toHaveBeenCalledTimes(1));
  });
});

// The launch gate opens after the FIRST init attempt whatever it did, so on a
// contended launch SQLiteProvider renders this bridge against a connection whose
// migrations never ran — no board_climb_grades, no characteristics column. Both
// branches of the sync effect WRITE, so both have to wait.
describe('OfflineSyncBridge — schema readiness gating', () => {
  it('does not start the scheduler against a database whose migrations have not run', async () => {
    setSchemaReady(false);
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);

    // Notifications are readiness-independent, so waiting on them proves the effects
    // have flushed rather than merely not run yet.
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
    expect(startSyncSchedulerMock).not.toHaveBeenCalled();
  });

  it('starts the scheduler exactly once when readiness lands late', async () => {
    setSchemaReady(false);
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));

    // A retry won seconds after launch.
    act(() => setSchemaReady(true));

    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
  });

  it('holds the flag-off leftover drain until the schema is stamped', async () => {
    setSchemaReady(false);
    getPendingCountMock.mockResolvedValue(3);
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
    expect(getPendingCountMock).not.toHaveBeenCalled();

    act(() => setSchemaReady(true));

    await waitFor(() => expect(drainMutationQueueMock).toHaveBeenCalledTimes(1));
  });
});

describe('OfflineSyncBridge — flag never resolved', () => {
  it('runs the engine anyway: scheduler starts and the module store flips on', async () => {
    render(<Harness flags={FLAG_UNSET} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(isOfflineEngineEnabled()).toBe(true));
    expect(getPendingCountMock).not.toHaveBeenCalled();
  });
});

describe('OfflineEngineFlagSync — offline_engine_state super property', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers flag-on for a resolved true, without waiting', () => {
    render(<FlagSyncHarness flags={FLAG_ON} />);
    expect(registerOfflineEngineStateMock).toHaveBeenCalledWith('flag-on');
  });

  it('registers flag-off for a resolved false', () => {
    render(<FlagSyncHarness flags={FLAG_OFF} />);
    expect(registerOfflineEngineStateMock).toHaveBeenCalledWith('flag-off');
  });

  it('registers default-on only once the flag has failed to resolve for FLAG_SETTLE_MS', () => {
    render(<FlagSyncHarness flags={FLAG_UNSET} />);
    expect(registerOfflineEngineStateMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(FLAG_SETTLE_MS);
    });
    expect(registerOfflineEngineStateMock).toHaveBeenCalledWith('default-on');
  });

  it('never registers default-on when the flag resolves inside the settle window', () => {
    const { rerender } = render(<FlagSyncHarness flags={FLAG_UNSET} />);
    act(() => {
      vi.advanceTimersByTime(FLAG_SETTLE_MS / 2);
    });

    rerender(<FlagSyncHarness flags={FLAG_ON} />);
    act(() => {
      vi.advanceTimersByTime(FLAG_SETTLE_MS);
    });

    expect(registerOfflineEngineStateMock).toHaveBeenCalledWith('flag-on');
    expect(registerOfflineEngineStateMock).not.toHaveBeenCalledWith('default-on');
  });
});

describe('OfflineEngineFlagSync', () => {
  it('publishes the flag decision to the module-level store, tracking flips', async () => {
    expect(isOfflineEngineEnabled()).toBe(false);
    const queryClient = makeQueryClient();
    const { rerender } = render(<Harness flags={FLAG_ON} queryClient={queryClient} />);
    await waitFor(() => expect(isOfflineEngineEnabled()).toBe(true));

    rerender(<Harness flags={FLAG_OFF} queryClient={queryClient} />);
    await waitFor(() => expect(isOfflineEngineEnabled()).toBe(false));
  });
});
