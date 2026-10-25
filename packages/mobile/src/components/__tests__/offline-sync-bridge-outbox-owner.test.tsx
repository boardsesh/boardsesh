// @vitest-environment jsdom
// Account A's queued offline writes must never be sent under account B's token.
//
// The outbox (`pending_mutations`) records no owner: the only record of whose rows
// are on disk is the one `sync_meta` stamp, and the server files a replayed write
// under whoever's token carries it (`saveTick` reads `ctx.userId`, and
// SaveTickInput has no user field). The light signed-out launch, a session that
// expired while the app was closed, leaves A's outbox on disk. When B signs in,
// the owner-stamp effect in OfflineSyncBridge is what wipes it, and that effect
// waits for an async read of the stored user id. The scheduler effect does not
// wait, and every cycle drains the outbox first.
//
// Everything that decides the outcome is real here: the bridge, the engine's
// scheduler, drainer and owner stamp, `clearUserData`, the stored-user-id query,
// the readiness gates, and the database (real migrations over node:sqlite). The
// stand-ins are the network (`request`, which on a device attaches the signed-in
// account's token) and the edges that cannot load in this environment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SQLiteDatabase } from 'expo-sqlite';

vi.mock('../../notifications/use-notification-updates', () => ({ useNotificationUpdates: () => {} }));
vi.mock('../../lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthors: () => ({}),
  loadFollowedAuthors: async () => ({ setterUsernames: [], users: [] }),
}));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../lib/analytics-offline-engine-state', () => ({ registerOfflineEngineState: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({
  reportError: vi.fn(),
  reportHandledError: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}));
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: vi.fn() }));
vi.mock('../../sync', () => ({
  setSyncProgress: vi.fn(),
  notifyBootstrapMetadataChanged: vi.fn(),
  notifyScopeDownloadComplete: vi.fn(),
}));
vi.mock('../../settings', () => ({ getSetting: () => [] }));
vi.mock('../../lib/env', () => ({ isSnapshotBaseUrlConfigured: () => false }));
vi.mock('../../offline/snapshot-source', () => ({ mobileSnapshotSource: {} }));
vi.mock('../../lib/spray/spray-photo-store', () => ({ clearStoredSprayPhotos: vi.fn() }));
// Launch-time reporting only; neither sends a queued write.
vi.mock('../../offline/outbox-telemetry', () => ({ recoverAndReportOutboxOnce: async () => {} }));
vi.mock('../../offline/abandoned-download-terminals', () => ({ sweepDelistedDownloadTerminals: async () => {} }));

// The signed-in account, as the auth provider publishes it. Mutable: the case
// starts on the login screen and then signs B in.
const auth = vi.hoisted(() => ({ isAuthenticated: false, storedUserId: 'user-b' }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: auth.isAuthenticated, isLoading: false }),
}));
// The id `useStoredUserId` decodes from the token in SecureStore. The hook itself
// is real: its answer arrives a render after sign-in, as it does on a device.
vi.mock('../../lib/local-user-id', () => ({ readLocalUserId: async () => auth.storedUserId }));

// Every request the offline client makes. On a device this client attaches the
// signed-in account's token, so anything recorded here was sent as that account.
type SentRequest = { operation: string; variables: Record<string, unknown> | undefined; wipeEpoch: number };
const network = vi.hoisted(() => ({ sent: [] as SentRequest[], wipeEpoch: (): number => 0 }));
vi.mock('../../lib/graphql/client', () => ({
  getOfflineSyncHttpClient: () => ({
    request: async (query: string, variables?: Record<string, unknown>) => {
      const operation = /(?:mutation|query)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
      network.sent.push({ operation, variables, wipeEpoch: network.wipeEpoch() });
      if (operation === 'SaveTick') {
        const input = variables?.input as { uuid?: string } | undefined;
        return { saveTick: { uuid: input?.uuid } };
      }
      return {};
    },
  }),
  getHttpClient: () => ({ request: vi.fn() }),
}));

// The adapter binds AppState/NetInfo and the connectivity store, which cannot load
// here. These are the engine's own scheduler and drainer, with the device online
// for the drain. The pull half is held offline so it sends nothing: what this
// suite measures is the outbox, and a pull would only add requests to filter out.
vi.mock('../../offline/offline-sync-adapter', async () => {
  const engine = await vi.importActual<typeof import('@boardsesh/offline-sync')>('@boardsesh/offline-sync');
  const inertTriggers = {
    subscribeForeground: () => () => {},
    subscribeConnectivity: () => () => {},
  };
  return {
    drainMutationQueue: (...[db, queryClient, graphqlFetch]: Parameters<typeof engine.drainMutationQueue>) =>
      engine.drainMutationQueue(db, queryClient, graphqlFetch, { isOnline: () => true }),
    startSyncScheduler: (
      ...[db, queryClient, graphqlFetch, getEnabledBoards, drainQueue]: Parameters<typeof engine.startSyncScheduler>
    ) =>
      engine.startSyncScheduler(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, inertTriggers, {
        isOnline: () => false,
      }),
    startBackgroundTracking: () => () => {},
  };
});

const database = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => database.current }));

import { OfflineSyncBridge } from '../offline-sync-bridge';
import { LaunchReadyProvider } from '../../providers/launch-ready-context';
import { setSchemaReady, __resetSchemaReadyForTests } from '../../db/schema-ready';
import {
  enqueue,
  getLocalUserId,
  getPendingCount,
  getWipeEpoch,
  runMigrations,
  stampLocalUserId,
} from '@boardsesh/offline-sync';
import {
  createTestDatabase,
  __resetDrainerStateForTests,
  __resetSyncSchedulerStateForTests,
  type TestSqliteDb,
} from '@boardsesh/offline-sync/testing';

const A_TICK_UUID = '6f1c1d5e-0000-4000-8000-00000000000a';

// What `writeTickLocal` queues for an offline send: the SaveTickInput the log
// sheet built, keyed by the tick's own uuid.
const A_TICK_INPUT = {
  boardType: 'kilter',
  climbUuid: 'climb-of-a',
  angle: 40,
  isMirror: false,
  status: 'send',
  attemptCount: 3,
  quality: 3,
  difficulty: 20,
  isBenchmark: false,
  comment: "A's private note",
  climbedAt: '2026-10-20T18:00:00.000Z',
};

let db: TestSqliteDb & SQLiteDatabase;

function Harness({ queryClient }: { queryClient: QueryClient }) {
  return (
    <LaunchReadyProvider ready>
      <QueryClientProvider client={queryClient}>
        <OfflineSyncBridge />
      </QueryClientProvider>
    </LaunchReadyProvider>
  );
}

/** A's device after a session that expired while the app was closed. */
async function seedAccountAOutbox(): Promise<void> {
  await runMigrations(db);
  await stampLocalUserId(db, 'user-a');
  await enqueue(db, 'boardsesh_ticks', 'create', A_TICK_INPUT, A_TICK_UUID);
}

function tickUuidOf(request: SentRequest): string | undefined {
  if (request.operation !== 'SaveTick') return undefined;
  const input = request.variables?.input as { uuid?: string } | undefined;
  return input?.uuid;
}

function sentTickUuids(): (string | undefined)[] {
  return network.sent.filter((request) => request.operation === 'SaveTick').map(tickUuidOf);
}

async function signIn(view: ReturnType<typeof render>, queryClient: QueryClient, userId: string): Promise<void> {
  auth.isAuthenticated = true;
  auth.storedUserId = userId;
  await act(async () => {
    view.rerender(<Harness queryClient={queryClient} />);
  });
}

beforeEach(() => {
  db = createTestDatabase() as TestSqliteDb & SQLiteDatabase;
  database.current = db;
  network.sent.length = 0;
  network.wipeEpoch = getWipeEpoch;
  auth.isAuthenticated = false;
  auth.storedUserId = 'user-b';
  setSchemaReady(true);
});

afterEach(() => {
  __resetSchemaReadyForTests();
  __resetSyncSchedulerStateForTests();
  __resetDrainerStateForTests();
  db.close();
});

describe('OfflineSyncBridge: the outbox at an account switch', () => {
  it("never sends account A's queued tick when account B signs in", async () => {
    await seedAccountAOutbox();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const epochAtLaunch = getWipeEpoch();

    // The light signed-out launch: the login screen, nobody authenticated.
    const view = render(<Harness queryClient={queryClient} />);
    await signIn(view, queryClient, 'user-b');

    // The owner-stamp effect has settled: the device now belongs to B.
    await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
    // ...and A's outbox went with the wipe.
    expect(await getPendingCount(db)).toBe(0);

    const leaked = network.sent.filter((request) => tickUuidOf(request) === A_TICK_UUID);
    // Before the fix the drain sends it straight away, under B's token, at the
    // launch's wipe epoch: before the owner wipe's purge had even started.
    expect(
      leaked.map((request) => ({ uuid: A_TICK_UUID, beforeOwnerWipe: request.wipeEpoch === epochAtLaunch })),
    ).toEqual([]);

    view.unmount();
  });

  it("still sends A's queued tick when A signs back in", async () => {
    // The outbox outlives the light signed-out launch on purpose: a climber whose
    // session lapsed with a send still queued gets it delivered on their return.
    await seedAccountAOutbox();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view = render(<Harness queryClient={queryClient} />);
    await signIn(view, queryClient, 'user-a');

    await waitFor(async () => expect(await getPendingCount(db)).toBe(0));
    expect(sentTickUuids()).toEqual([A_TICK_UUID]);
    expect(await getLocalUserId(db)).toBe('user-a');

    view.unmount();
  });
});
