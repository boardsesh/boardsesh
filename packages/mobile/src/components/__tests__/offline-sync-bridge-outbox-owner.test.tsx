// @vitest-environment jsdom
// Account A's queued offline writes must never be sent under account B's token
// (#6824).
//
// The outbox (`pending_mutations`) records no owner: the only record of whose rows
// are on disk is the one `sync_meta` stamp, and the server files a replayed write
// under whoever's token carries it (`saveTick` reads `ctx.userId`, and
// SaveTickInput has no user field). The light signed-out launch, a session that
// expired while the app was closed, leaves A's outbox on disk. When B signs in,
// the owner-stamp effect in OfflineSyncBridge is what wipes it, and that effect
// waits for an async read of the stored user id. Two guards keep A's writes in:
// the bridge holds the scheduler until the owner claim settles, and the drainer
// itself sends only when the stamp names the account in the token.
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
const reportHandledErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({
  reportError: vi.fn(),
  reportHandledError: reportHandledErrorMock,
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

// The signed-in account, as the auth provider publishes it, and the user id in
// the token in SecureStore. Mutable: each case starts on the login screen.
const auth = vi.hoisted(() => ({ isAuthenticated: false, tokenUserId: 'user-b' as string | undefined }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: auth.isAuthenticated, isLoading: false }),
}));
// What `useStoredUserId` decodes from that token. The hook itself is real: its
// answer arrives a render after sign-in, as it does on a device.
vi.mock('../../lib/local-user-id', () => ({ readLocalUserId: async () => auth.tokenUserId }));

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

// The adapter binds AppState/NetInfo, SecureStore and the connectivity store,
// which cannot load here. These are the engine's own scheduler and drainer, bound
// the way the adapter binds them: the drain asks the token who is signed in, and
// the device is online for it. The pull half is held offline so it sends
// nothing: what this suite measures is the outbox. `schedulerStarts` records the
// wipe epoch each scheduler started at.
const schedulerStarts = vi.hoisted(() => [] as number[]);
vi.mock('../../offline/offline-sync-adapter', async () => {
  const engine = await vi.importActual<typeof import('@boardsesh/offline-sync')>('@boardsesh/offline-sync');
  const inertTriggers = {
    subscribeForeground: () => () => {},
    subscribeConnectivity: () => () => {},
  };
  const getSignedInUserId = async () => (auth.isAuthenticated ? auth.tokenUserId : undefined);
  return {
    drainMutationQueue: (...[db, queryClient, graphqlFetch]: Parameters<typeof engine.drainMutationQueue>) =>
      engine.drainMutationQueue(db, queryClient, graphqlFetch, { isOnline: () => true, getSignedInUserId }),
    startSyncScheduler: (
      ...[db, queryClient, graphqlFetch, getEnabledBoards, drainQueue]: Parameters<typeof engine.startSyncScheduler>
    ) => {
      schedulerStarts.push(engine.getWipeEpoch());
      return engine.startSyncScheduler(db, queryClient, graphqlFetch, getEnabledBoards, drainQueue, inertTriggers, {
        isOnline: () => false,
        getViewerUserId: getSignedInUserId,
        requireOwnedDatabase: true,
      });
    },
    startBackgroundTracking: () => () => {},
  };
});

const database = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => database.current }));

import { OfflineSyncBridge } from '../offline-sync-bridge';
import { drainMutationQueue } from '../../offline/offline-sync-adapter';
import { getOfflineSyncHttpClient } from '../../lib/graphql/client';
import { LaunchReadyProvider } from '../../providers/launch-ready-context';
import { setSchemaReady, __resetSchemaReadyForTests } from '../../db/schema-ready';
import {
  enqueue,
  getLocalUserId,
  getPendingCount,
  getWipeEpoch,
  runMigrations,
  stampLocalUserId,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import {
  createTestDatabase,
  __resetDrainerStateForTests,
  __resetSyncSchedulerStateForTests,
  type TestSqliteDb,
} from '@boardsesh/offline-sync/testing';

const A_TICK_UUID = '6f1c1d5e-0000-4000-8000-00000000000a';
const B_TICK_UUID = '6f1c1d5e-0000-4000-8000-00000000000b';

// What `writeTickLocal` queues for an offline send: the SaveTickInput the log
// sheet built, keyed by the tick's own uuid.
const tickInput = (comment: string) => ({
  boardType: 'kilter',
  climbUuid: 'climb-1',
  angle: 40,
  isMirror: false,
  status: 'send',
  attemptCount: 3,
  quality: 3,
  difficulty: 20,
  isBenchmark: false,
  comment,
  climbedAt: '2026-10-20T18:00:00.000Z',
});

// The drain a tick save starts on its own (useSaveTick, board-adapter), through
// the same client as the bridge, so its sends are recorded the same way.
const sendThroughAppClient: GraphQLFetch = (query, variables) => getOfflineSyncHttpClient().request(query, variables);

type OutboxRow = { idempotency_key: string; status: string; retry_count: number; last_error: string | null };

let db: TestSqliteDb & SQLiteDatabase;
// Flipped to make `clearUserData`'s exclusive transaction fail the way a locked
// database does (#4314).
const lockedDatabase = { failTransactions: false };

/** The connection the app holds, with a switchable lock on its write transactions. */
function openDatabase(): TestSqliteDb & SQLiteDatabase {
  const real = createTestDatabase();
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'withExclusiveTransactionAsync' && lockedDatabase.failTransactions) {
        return async () => {
          throw new Error('SQLiteErrorException: Error code 5: database is locked');
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TestSqliteDb & SQLiteDatabase;
}

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
  await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's private note"), A_TICK_UUID);
}

function tickUuidOf(request: SentRequest): string | undefined {
  if (request.operation !== 'SaveTick') return undefined;
  const input = request.variables?.input as { uuid?: string } | undefined;
  return input?.uuid;
}

function sentTickUuids(): (string | undefined)[] {
  return network.sent.filter((request) => request.operation === 'SaveTick').map(tickUuidOf);
}

function outbox(): Promise<OutboxRow[]> {
  return db.getAllAsync<OutboxRow>(
    'SELECT idempotency_key, status, retry_count, last_error FROM pending_mutations ORDER BY id',
  );
}

/** Opens the app on the login screen (the light signed-out launch). */
function launch(): { view: ReturnType<typeof render>; queryClient: QueryClient } {
  auth.isAuthenticated = false;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { view: render(<Harness queryClient={queryClient} />), queryClient };
}

async function signIn(
  { view, queryClient }: ReturnType<typeof launch>,
  tokenUserId: string | undefined,
): Promise<void> {
  auth.isAuthenticated = true;
  auth.tokenUserId = tokenUserId;
  await act(async () => {
    view.rerender(<Harness queryClient={queryClient} />);
  });
}

/** Lets every pending SQLite call, query resolution and effect run out. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  lockedDatabase.failTransactions = false;
  db = openDatabase();
  database.current = db;
  network.sent.length = 0;
  network.wipeEpoch = getWipeEpoch;
  schedulerStarts.length = 0;
  reportHandledErrorMock.mockClear();
  auth.isAuthenticated = false;
  auth.tokenUserId = 'user-b';
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
    const epochAtLaunch = getWipeEpoch();

    const app = launch();
    await signIn(app, 'user-b');

    // The owner-stamp effect has settled: the device now belongs to B.
    await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
    // ...and A's outbox went with the wipe.
    expect(await getPendingCount(db)).toBe(0);

    const leaked = network.sent.filter((request) => tickUuidOf(request) === A_TICK_UUID);
    // Before the fix the drain sent it straight away, under B's token, at the
    // launch's wipe epoch: before the owner wipe's purge had even started.
    expect(
      leaked.map((request) => ({ uuid: A_TICK_UUID, beforeOwnerWipe: request.wipeEpoch === epochAtLaunch })),
    ).toEqual([]);

    app.view.unmount();
  });

  it('starts the scheduler only after the owner wipe, never at sign-in', async () => {
    await seedAccountAOutbox();
    const epochAtLaunch = getWipeEpoch();

    const app = launch();
    await signIn(app, 'user-b');
    await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
    await waitFor(() => expect(schedulerStarts).toHaveLength(1));

    // The wipe bumps the epoch before it deletes anything; a scheduler started at
    // the launch's epoch ran ahead of it.
    expect(schedulerStarts[0]).toBeGreaterThan(epochAtLaunch);

    app.view.unmount();
  });

  it("still sends A's queued tick when A signs back in", async () => {
    // The outbox outlives the light signed-out launch on purpose: a climber whose
    // session lapsed with a send still queued gets it delivered on their return.
    await seedAccountAOutbox();

    const app = launch();
    await signIn(app, 'user-a');

    await waitFor(async () => expect(await getPendingCount(db)).toBe(0));
    expect(sentTickUuids()).toEqual([A_TICK_UUID]);
    expect(await getLocalUserId(db)).toBe('user-a');

    app.view.unmount();
  });

  it('holds a write queued before the claim without charging it, and sends it once after', async () => {
    // A fresh install: B signs in and logs a send before the bridge has stamped
    // the database. The tick save's own drain runs first, and must wait.
    await runMigrations(db);
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("B's send"), B_TICK_UUID);

    const app = launch();
    auth.isAuthenticated = true;
    auth.tokenUserId = 'user-b';
    await drainMutationQueue(db, app.queryClient, sendThroughAppClient);
    expect(sentTickUuids()).toEqual([]);
    expect(await outbox()).toEqual([
      { idempotency_key: B_TICK_UUID, status: 'pending', retry_count: 0, last_error: null },
    ]);

    await signIn(app, 'user-b');
    await waitFor(async () => expect(await getPendingCount(db)).toBe(0));
    await settle();

    expect(sentTickUuids()).toEqual([B_TICK_UUID]);
    expect(await getLocalUserId(db)).toBe('user-b');

    app.view.unmount();
  });

  describe('fails closed', () => {
    it('holds sync for the session when the owner wipe fails, and the next launch retries it', async () => {
      await seedAccountAOutbox();
      lockedDatabase.failTransactions = true;

      const firstLaunch = launch();
      await signIn(firstLaunch, 'user-b');
      await waitFor(() => expect(reportHandledErrorMock).toHaveBeenCalled());
      await settle();

      // Nothing drained or pulled, and the database still says it is A's.
      expect(schedulerStarts).toEqual([]);
      expect(await getLocalUserId(db)).toBe('user-a');
      // A tick save in this session drains on its own, and must not send A's write.
      await drainMutationQueue(db, firstLaunch.queryClient, sendThroughAppClient);
      expect(network.sent).toEqual([]);
      expect(await outbox()).toEqual([
        { idempotency_key: A_TICK_UUID, status: 'pending', retry_count: 0, last_error: null },
      ]);

      // Reported once, by reason, with no account ids.
      expect(reportHandledErrorMock).toHaveBeenCalledTimes(1);
      const [error, context] = reportHandledErrorMock.mock.calls[0] as [Error, { tags: Record<string, string> }];
      expect(context.tags).toEqual({ source: 'offline-sync', op: 'owner-claim-hold', reason: 'prepare-failed' });
      expect(JSON.stringify([error.message, context])).not.toMatch(/user-a|user-b/);

      firstLaunch.view.unmount();

      // The next launch: a fresh process, the lock gone. Nothing about the hold
      // was persisted, so the claim runs from scratch and completes.
      __resetSyncSchedulerStateForTests();
      __resetDrainerStateForTests();
      lockedDatabase.failTransactions = false;
      const secondLaunch = launch();
      await signIn(secondLaunch, 'user-b');

      await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
      expect(await getPendingCount(db)).toBe(0);
      await waitFor(() => expect(schedulerStarts).toHaveLength(1));
      await settle();
      expect(sentTickUuids()).toEqual([]);

      secondLaunch.view.unmount();
    });

    it('holds sync when the token carries no readable user id, and says so once', async () => {
      await seedAccountAOutbox();

      const app = launch();
      await signIn(app, undefined);
      await waitFor(() => expect(reportHandledErrorMock).toHaveBeenCalled());
      await settle();

      expect(schedulerStarts).toEqual([]);
      expect(network.sent).toEqual([]);
      expect(await getLocalUserId(db)).toBe('user-a');
      expect(reportHandledErrorMock).toHaveBeenCalledTimes(1);
      const [, context] = reportHandledErrorMock.mock.calls[0] as [Error, { tags: Record<string, string> }];
      expect(context.tags).toEqual({ source: 'offline-sync', op: 'owner-claim-hold', reason: 'no-user-id' });

      app.view.unmount();
    });
  });
});
