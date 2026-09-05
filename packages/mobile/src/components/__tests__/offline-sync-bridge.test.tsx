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

// Native offline mode is baked on. The bridge still owns auth/schema lifecycle,
// scheduler teardown, progress wiring, and notifications.

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
vi.mock('../../offline/snapshot-source', () => ({
  mobileSnapshotSource: mobileSnapshotSourceStub,
}));

const getPendingCountMock = vi.fn(async (..._args: unknown[]) => 0);
// Owner-stamp plumbing: the bridge is where the device learns whose user-data
// rows it holds, so a wrong-account stamp has to trigger the wipe from here.
const assertLocalUserDataOwnerMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'ok'));
const stampLocalUserIdMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const clearUserDataMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const beginGlobalPurgeMock = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/offline-sync', () => ({
  getPendingCount: (...args: unknown[]) => getPendingCountMock(...args),
  assertLocalUserDataOwner: (...args: unknown[]) => assertLocalUserDataOwnerMock(...args),
  stampLocalUserId: (...args: unknown[]) => stampLocalUserIdMock(...args),
  beginGlobalPurge: (...args: unknown[]) => beginGlobalPurgeMock(...args),
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
const recoverAndReportOutboxOnceMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../../offline/outbox-telemetry', () => ({
  recoverAndReportOutboxOnce: recoverAndReportOutboxOnceMock,
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
  getOfflineSyncHttpClient: () => ({ request: vi.fn() }),
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

import { OfflineSyncBridge, OfflineEngineFlagSync } from '../offline-sync-bridge';
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
  beginGlobalPurgeMock.mockClear();
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
    // The GLOBAL epoch bump must land BEFORE the wipe: a pull page already on the
    // wire when clearUserData ran would otherwise land afterwards and resurrect
    // rows with a checkpoint past them — a gap `user_data_complete` would then
    // falsely vouch for. Global rather than scoped because clearUserData DELETEs
    // every user table, which no board namespace bounds (issue #4370).
    expect(beginGlobalPurgeMock).toHaveBeenCalledTimes(1);
    expect(beginGlobalPurgeMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearUserDataMock.mock.invocationCallOrder[0],
    );
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

  it('ignores a stale offline-downloads false value', async () => {
    assertLocalUserDataOwnerMock.mockResolvedValue('unstamped');
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(stampLocalUserIdMock).toHaveBeenCalledTimes(1));
  });
});

describe('OfflineSyncBridge — baked-on native engine', () => {
  it('starts the sync scheduler', async () => {
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

  it('passes the mobile snapshot source even when legacy rollout flags are false', async () => {
    render(<Harness flags={FLAG_OFF} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
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

describe('OfflineSyncBridge — legacy flag changes', () => {
  it('does not restart or stop the scheduler when stale PostHog values change', async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = render(<Harness flags={FLAG_ON} queryClient={queryClient} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));

    rerender(<Harness flags={FLAG_OFF} queryClient={queryClient} />);

    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    expect(startSyncSchedulerStop).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('OfflineSyncBridge — outbox backlog gauge', () => {
  it('reads the backlog once for a signed-in launch', async () => {
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);

    await waitFor(() => expect(recoverAndReportOutboxOnceMock).toHaveBeenCalledTimes(1));
    expect(recoverAndReportOutboxOnceMock).toHaveBeenCalledWith(fakeDb);
  });

  it('does not read anything while signed out', async () => {
    isAuthenticated = false;
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);

    await waitFor(() => expect(startBackgroundTrackingMock).toHaveBeenCalled());
    expect(recoverAndReportOutboxOnceMock).not.toHaveBeenCalled();
  });

  it('does not re-read when unrelated feature flags change', async () => {
    const queryClient = makeQueryClient();
    const { rerender } = render(<Harness flags={FLAG_ON} queryClient={queryClient} />);
    await waitFor(() => expect(recoverAndReportOutboxOnceMock).toHaveBeenCalledTimes(1));

    rerender(<Harness flags={FLAG_OFF} queryClient={queryClient} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));

    expect(recoverAndReportOutboxOnceMock).toHaveBeenCalledTimes(1);
  });

  it('waits for a stamped schema before reading the outbox', async () => {
    // Same hazard as the sync effect: on a contended launch pending_mutations
    // does not exist yet, and a gauge that throws there reports no backlog at
    // all rather than the backlog it could not read.
    setSchemaReady(false);
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
    expect(recoverAndReportOutboxOnceMock).not.toHaveBeenCalled();

    act(() => setSchemaReady(true));

    await waitFor(() => expect(recoverAndReportOutboxOnceMock).toHaveBeenCalledTimes(1));
  });
});

// The launch gate opens after the FIRST init attempt whatever it did, so on a
// contended launch SQLiteProvider renders this bridge against a connection whose
// migrations never ran — no board_climb_grades, no characteristics column. Both
// the sync effect writes, so it has to wait.
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
});

describe('OfflineSyncBridge — no PostHog values', () => {
  it('starts the scheduler and publishes the baked-on module state', async () => {
    render(<Harness flags={FLAG_UNSET} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(isOfflineEngineEnabled()).toBe(true));
    expect(getPendingCountMock).not.toHaveBeenCalled();
  });
});

describe('OfflineEngineFlagSync — offline_engine_state super property', () => {
  it('registers baked-on immediately even when a stale flag says false', () => {
    render(<FlagSyncHarness flags={FLAG_OFF} />);
    expect(registerOfflineEngineStateMock).toHaveBeenCalledWith('baked-on');
  });
});

describe('OfflineEngineFlagSync', () => {
  it('publishes true to the module store and ignores legacy flag flips', async () => {
    expect(isOfflineEngineEnabled()).toBe(false);
    const queryClient = makeQueryClient();
    const { rerender } = render(<Harness flags={FLAG_ON} queryClient={queryClient} />);
    await waitFor(() => expect(isOfflineEngineEnabled()).toBe(true));

    rerender(<Harness flags={FLAG_OFF} queryClient={queryClient} />);
    await waitFor(() => expect(isOfflineEngineEnabled()).toBe(true));
  });
});
