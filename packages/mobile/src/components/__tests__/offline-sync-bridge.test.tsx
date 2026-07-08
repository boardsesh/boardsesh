// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The bridge is the flag boundary of the offline engine: scheduler only when
// `offline-board-downloads` is on, a one-shot leftover drain when it's off
// (queued writes must never strand), notifications always.

const startSyncSchedulerStop = vi.fn();
const startSyncSchedulerMock = vi.fn(() => startSyncSchedulerStop);
vi.mock('../../sync', () => ({
  setSyncProgress: vi.fn(),
}));

const drainMutationQueueMock = vi.fn(async (..._args: unknown[]) => {});
// The scheduler + drain bindings live in the adapter (which statically imports
// react-native — mock it so Rolldown's scan never parses the RN Flow entry).
vi.mock('../../offline/offline-sync-adapter', () => ({
  startSyncScheduler: (...args: unknown[]) => startSyncSchedulerMock(...(args as [])),
  drainMutationQueue: (...args: unknown[]) => drainMutationQueueMock(...args),
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
vi.mock('@boardsesh/offline-sync', () => ({
  getPendingCount: (...args: unknown[]) => getPendingCountMock(...args),
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

const FLAG_ON: FeatureFlags = { 'offline-board-downloads': true };
const FLAG_OFF: FeatureFlags = { 'offline-board-downloads': false };
const FLAG_ON_WITH_SNAPSHOT: FeatureFlags = { 'offline-board-downloads': true, 'offline-snapshot-bootstrap': true };

beforeEach(() => {
  vi.clearAllMocks();
  startSyncSchedulerMock.mockReturnValue(startSyncSchedulerStop);
  getPendingCountMock.mockResolvedValue(0);
  isAuthenticated = true;
});

afterEach(() => {
  __resetOfflineEngineForTests();
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

  it('passes no snapshotSource when offline-snapshot-bootstrap is off', async () => {
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    // 7th positional arg (index 6) is the optional snapshotSource.
    const call = startSyncSchedulerMock.mock.calls[0] as unknown as unknown[];
    expect(call[6]).toBeUndefined();
  });

  it('passes the mobile snapshot source when offline-snapshot-bootstrap is also on', async () => {
    render(<Harness flags={FLAG_ON_WITH_SNAPSHOT} queryClient={makeQueryClient()} />);
    await waitFor(() => expect(startSyncSchedulerMock).toHaveBeenCalledTimes(1));
    const call = startSyncSchedulerMock.mock.calls[0] as unknown as unknown[];
    expect(call[6]).toBe(mobileSnapshotSourceStub);
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
});

describe('OfflineSyncBridge — auth gating', () => {
  it('signed out: no scheduler, no leftover drain, no sync traffic at all', async () => {
    isAuthenticated = false;
    render(<Harness flags={FLAG_ON} queryClient={makeQueryClient()} />);
    // Notifications still set up — they are the only auth-independent effect.
    await waitFor(() => expect(setupNotificationHandlersMock).toHaveBeenCalledTimes(1));
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
