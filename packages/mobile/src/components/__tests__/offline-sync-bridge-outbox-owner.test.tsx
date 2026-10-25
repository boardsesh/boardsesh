// @vitest-environment jsdom
// Account A's queued offline writes must never be sent under account B's token,
// and every account must still get its sync once it signs in (#6824).
//
// The outbox (`pending_mutations`) records no owner: the only record of whose rows
// are on disk is the one `sync_meta` stamp, and the server files a replayed write
// under whoever's token carries it (`saveTick` reads `ctx.userId`, and
// SaveTickInput has no user field). The light signed-out launch, a session that
// expired while the app was closed, leaves A's outbox and A's token on disk. Two
// guards keep A's writes in: the bridge holds the scheduler until it has claimed
// the database for the account in the token, and the drainer sends only when the
// stamp names that account.
//
// Everything that decides the outcome is real here: the bridge, the engine's
// scheduler, drainer and owner stamp, `clearUserData`, the stored-user-id query
// and the always-on reader of it the bridge mounts (`useFollowedAuthors`), the
// readiness gates, and the database (real migrations over node:sqlite). The
// stand-ins are the token in SecureStore, the network (`request`, which on a
// device attaches that token) and the edges that cannot load in this environment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SQLiteDatabase } from 'expo-sqlite';

vi.mock('../../notifications/use-notification-updates', () => ({ useNotificationUpdates: () => {} }));
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
// The per-account settings the owner wipe resets (#6563). Their own behaviour is
// covered by account-boundary.test.ts; here they only must not throw.
vi.mock('../../settings', () => ({
  getSetting: () => [],
  setSetting: vi.fn(),
  clearOfflineBoards: vi.fn(),
  clearOwnedSprayWallPins: vi.fn(),
}));
vi.mock('../../lib/env', () => ({ isSnapshotBaseUrlConfigured: () => false }));
vi.mock('../../offline/snapshot-source', () => ({ mobileSnapshotSource: {} }));
vi.mock('../../lib/spray/spray-photo-store', () => ({ clearStoredSprayPhotos: vi.fn() }));
// Launch-time reporting only; neither sends a queued write.
vi.mock('../../offline/outbox-telemetry', () => ({ recoverAndReportOutboxOnce: async () => {} }));
vi.mock('../../offline/abandoned-download-terminals', () => ({
  sweepDelistedDownloadTerminals: async () => {},
  forgetAbandonedDownloads: async () => {},
}));

// Foreground transitions, which retry a claim that failed without deciding anything.
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

// The signed-in account as the auth provider publishes it, and the token in
// SecureStore: `null` for none, NO_SUB for a token that names nobody, else the
// user id it carries. They move separately on purpose: the light signed-out
// launch leaves the lapsed account's token in place while nobody is signed in.
const auth = vi.hoisted(() => ({ isAuthenticated: false, token: null as string | null, noSub: 'token-names-nobody' }));
const NO_SUB = auth.noSub;
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: auth.isAuthenticated, isLoading: false }),
}));
// What `useStoredUserId` decodes from that token. The hook is real, and so is its
// always-on reader in `useFollowedAuthors`, which caches an answer on the login screen.
vi.mock('../../lib/local-user-id', () => ({
  readLocalUserId: async () => (auth.token === null || auth.token === auth.noSub ? undefined : auth.token),
}));

// Every request the offline client makes. On a device this client attaches the
// token, so anything recorded here was sent as that account.
type SentRequest = { operation: string; variables: Record<string, unknown> | undefined; wipeEpoch: number };
const network = vi.hoisted(() => ({ sent: [] as SentRequest[], wipeEpoch: (): number => 0, online: true }));
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
  // The followed-authors reader's own fetch. Never answers, so it never writes.
  getHttpClient: () => ({ request: () => new Promise(() => {}) }),
}));

// The adapter binds AppState/NetInfo, SecureStore and the connectivity store,
// which cannot load here. These are the engine's own scheduler and drainer, bound
// the way the adapter binds them: the drain and the claim ask the token who is
// signed in, and the device is online for the drain. The pull half is held
// offline so it sends nothing: what this suite measures is the outbox.
// `schedulerStarts` records the wipe epoch each scheduler started at.
const schedulerStarts = vi.hoisted(() => [] as number[]);
vi.mock('../../offline/offline-sync-adapter', async () => {
  const engine = await vi.importActual<typeof import('@boardsesh/offline-sync')>('@boardsesh/offline-sync');
  const inertTriggers = {
    subscribeForeground: () => () => {},
    subscribeConnectivity: () => () => {},
  };
  const readSignedInAccount = async () => {
    if (auth.token === null) return { status: 'unsettled' as const };
    if (auth.token === auth.noSub) return { status: 'no-user-id' as const };
    return { status: 'signed-in' as const, userId: auth.token };
  };
  const getSignedInUserId = async () => {
    const account = await readSignedInAccount();
    return account.status === 'signed-in' ? account.userId : undefined;
  };
  return {
    readSignedInAccount,
    drainMutationQueue: (...[db, queryClient, graphqlFetch]: Parameters<typeof engine.drainMutationQueue>) =>
      engine.drainMutationQueue(db, queryClient, graphqlFetch, { isOnline: () => network.online, getSignedInUserId }),
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
import { clearUserData } from '../../db/connection';
import {
  enqueue,
  getLocalUserId,
  getPendingCount,
  getWipeEpoch,
  LOCAL_USER_ID_KEY,
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
const untouched = (key: string): OutboxRow => ({
  idempotency_key: key,
  status: 'pending',
  retry_count: 0,
  last_error: null,
});

let db: TestSqliteDb & SQLiteDatabase;
// Switchable faults on the app's connection: `clearUserData`'s exclusive
// transaction failing the way a locked database does (#4314), and the owner
// stamp's read failing a set number of times.
const faults = { lockTransactions: false, failedStampReads: 0 };

function openDatabase(): TestSqliteDb & SQLiteDatabase {
  const real = createTestDatabase();
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'withExclusiveTransactionAsync' && faults.lockTransactions) {
        return async () => {
          throw new Error('SQLiteErrorException: Error code 5: database is locked');
        };
      }
      if (property === 'getFirstAsync') {
        return async <T,>(source: string, ...params: (string | number | null)[]): Promise<T | null> => {
          if (faults.failedStampReads > 0 && JSON.stringify(params).includes(LOCAL_USER_ID_KEY)) {
            faults.failedStampReads -= 1;
            throw new Error('SQLiteErrorException: Error code 10: disk I/O error');
          }
          return target.getFirstAsync<T>(source, ...params);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
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

type App = { view: ReturnType<typeof render>; queryClient: QueryClient };

/** Lets every pending SQLite call, query resolution and effect run out. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Opens the app on the login screen, with whatever token SecureStore holds. */
async function launch(): Promise<App> {
  auth.isAuthenticated = false;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = { view: render(<Harness queryClient={queryClient} />), queryClient };
  // Let the login screen's readers cache their answers, as they do on a device.
  await settle();
  return app;
}

/**
 * A sign-in: the tokens are stored, then the provider publishes the session. It
 * deliberately does NOT reset the stored-id query the way AuthProvider does: the
 * owner claim must not depend on that cache being fresh.
 */
async function signIn({ view, queryClient }: App, userId: string): Promise<void> {
  auth.token = userId;
  auth.isAuthenticated = true;
  await act(async () => {
    view.rerender(<Harness queryClient={queryClient} />);
  });
}

/** A forced sign-out, as `runSignedOutCleanup` runs it: tokens, outbox and query cache go. */
async function signOut({ view, queryClient }: App): Promise<void> {
  auth.token = null;
  await clearUserData(db);
  queryClient.clear();
  auth.isAuthenticated = false;
  await act(async () => {
    view.rerender(<Harness queryClient={queryClient} />);
  });
  await settle();
}

async function foreground(): Promise<void> {
  await act(async () => {
    for (const listener of appState.listeners) listener('active');
  });
  await settle();
}

/** A's device after a session that expired while the app was closed. */
async function seedAccountAOutbox(): Promise<void> {
  await runMigrations(db);
  await stampLocalUserId(db, 'user-a');
  await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's private note"), A_TICK_UUID);
  auth.token = 'user-a';
}

/** B logs a send; the tick save drains on its own straight away. */
async function logSendAsB(app: App): Promise<void> {
  await enqueue(db, 'boardsesh_ticks', 'create', tickInput("B's send"), B_TICK_UUID);
  await drainMutationQueue(db, app.queryClient, sendThroughAppClient);
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

function holdReports(): string[] {
  return reportHandledErrorMock.mock.calls.map(
    (call) => (call[1] as { tags: Record<string, string> }).tags.reason ?? 'unknown',
  );
}

beforeEach(() => {
  faults.lockTransactions = false;
  faults.failedStampReads = 0;
  db = openDatabase();
  database.current = db;
  network.sent.length = 0;
  network.wipeEpoch = getWipeEpoch;
  network.online = true;
  schedulerStarts.length = 0;
  appState.listeners.clear();
  reportHandledErrorMock.mockClear();
  auth.isAuthenticated = false;
  auth.token = null;
  setSchemaReady(true);
});

afterEach(() => {
  __resetSchemaReadyForTests();
  __resetSyncSchedulerStateForTests();
  __resetDrainerStateForTests();
  db.close();
});

describe('OfflineSyncBridge: the outbox at an account switch', () => {
  it("never sends account A's queued tick when account B signs in, and sends B's", async () => {
    await seedAccountAOutbox();
    const epochAtLaunch = getWipeEpoch();

    const app = await launch();
    await signIn(app, 'user-b');
    await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
    await logSendAsB(app);
    await settle();

    const leaked = network.sent.filter((request) => tickUuidOf(request) === A_TICK_UUID);
    // Before the fix the drain sent it straight away, under B's token, at the
    // launch's wipe epoch: before the owner wipe's purge had even started.
    expect(
      leaked.map((request) => ({ uuid: A_TICK_UUID, beforeOwnerWipe: request.wipeEpoch === epochAtLaunch })),
    ).toEqual([]);
    // A's write went with the wipe, unsent; B's went out.
    expect(sentTickUuids()).toEqual([B_TICK_UUID]);
    expect(await getPendingCount(db)).toBe(0);
    expect(reportHandledErrorMock).not.toHaveBeenCalled();

    app.view.unmount();
  });

  it('starts the scheduler only after the owner wipe, never at sign-in', async () => {
    await seedAccountAOutbox();
    const epochAtLaunch = getWipeEpoch();

    const app = await launch();
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

    const app = await launch();
    await signIn(app, 'user-a');

    await waitFor(async () => expect(await getPendingCount(db)).toBe(0));
    expect(sentTickUuids()).toEqual([A_TICK_UUID]);
    expect(await getLocalUserId(db)).toBe('user-a');

    app.view.unmount();
  });
});

// The paths the claim must never stall (review of #6825).
describe('OfflineSyncBridge: every sign-in gets its sync', () => {
  it('first sign-in on a fresh install: claims, starts sync, sends the held write once', async () => {
    await runMigrations(db);
    const app = await launch();
    await signIn(app, 'user-b');
    // B's tick save may drain before the claim lands: declined, untouched, then sent.
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("B's send"), B_TICK_UUID);
    await drainMutationQueue(db, app.queryClient, sendThroughAppClient);

    await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    await waitFor(async () => expect(await getPendingCount(db)).toBe(0));
    await settle();

    expect(sentTickUuids()).toEqual([B_TICK_UUID]);
    // The login screen cached "no id"; that is not a token that names nobody.
    expect(reportHandledErrorMock).not.toHaveBeenCalled();

    app.view.unmount();
  });

  it('sign-out then sign-in as another account, without a relaunch: claims for the new account', async () => {
    await runMigrations(db);
    const app = await launch();
    await signIn(app, 'user-a');
    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    await signOut(app);

    await signIn(app, 'user-b');
    await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
    await waitFor(() => expect(schedulerStarts).toHaveLength(2));
    await logSendAsB(app);
    await settle();

    expect(sentTickUuids()).toEqual([B_TICK_UUID]);
    expect(await getPendingCount(db)).toBe(0);

    app.view.unmount();
  });

  it('sign-out then sign-in as the same account, without a relaunch: sync starts again', async () => {
    await runMigrations(db);
    const app = await launch();
    await signIn(app, 'user-a');
    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    await signOut(app);

    await signIn(app, 'user-a');
    await waitFor(() => expect(schedulerStarts).toHaveLength(2));
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK_UUID);
    await drainMutationQueue(db, app.queryClient, sendThroughAppClient);

    expect(sentTickUuids()).toEqual([A_TICK_UUID]);
    expect(await getLocalUserId(db)).toBe('user-a');

    app.view.unmount();
  });

  it('a cold start already signed in claims and drains without anyone signing in', async () => {
    await runMigrations(db);
    await stampLocalUserId(db, 'user-a');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK_UUID);
    auth.token = 'user-a';
    auth.isAuthenticated = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<Harness queryClient={queryClient} />);

    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    await waitFor(async () => expect(await getPendingCount(db)).toBe(0));
    expect(sentTickUuids()).toEqual([A_TICK_UUID]);

    view.unmount();
  });

  it('a cold start with no connection still claims and starts the scheduler; the outbox waits', async () => {
    // Nothing in the claim needs the network: the token is in SecureStore and the
    // stamp in SQLite. Only the sends wait for a connection.
    await runMigrations(db);
    await stampLocalUserId(db, 'user-a');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("A's send"), A_TICK_UUID);
    network.online = false;
    auth.token = 'user-a';
    auth.isAuthenticated = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<Harness queryClient={queryClient} />);

    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    await settle();
    expect(network.sent).toEqual([]);
    expect(await outbox()).toEqual([untouched(A_TICK_UUID)]);
    expect(reportHandledErrorMock).not.toHaveBeenCalled();

    view.unmount();
  });
});

describe('OfflineSyncBridge: when the claim cannot be made', () => {
  it('retries a failed stamp read on the next foreground instead of holding the session', async () => {
    await runMigrations(db);
    faults.failedStampReads = 1;
    const app = await launch();
    await signIn(app, 'user-b');
    await settle();

    expect(schedulerStarts).toEqual([]);
    expect(reportHandledErrorMock).not.toHaveBeenCalled();

    await foreground();
    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    expect(await getLocalUserId(db)).toBe('user-b');
    expect(reportHandledErrorMock).not.toHaveBeenCalled();

    app.view.unmount();
  });

  it('stops retrying after three foregrounds and says so once', async () => {
    await runMigrations(db);
    faults.failedStampReads = Number.POSITIVE_INFINITY;
    const app = await launch();
    await signIn(app, 'user-b');
    await settle();
    for (let attempt = 0; attempt < 5; attempt += 1) await foreground();

    expect(schedulerStarts).toEqual([]);
    expect(holdReports()).toEqual(['claim-failed']);

    app.view.unmount();
  });

  it('holds sync for the session when the owner wipe fails, and the next launch retries it', async () => {
    await seedAccountAOutbox();
    faults.lockTransactions = true;

    const firstLaunch = await launch();
    await signIn(firstLaunch, 'user-b');
    await waitFor(() => expect(reportHandledErrorMock).toHaveBeenCalled());
    // A foreground does not retry it: the previous account's rows are still there.
    await foreground();

    // Nothing drained or pulled, and the database still says it is A's.
    expect(schedulerStarts).toEqual([]);
    expect(await getLocalUserId(db)).toBe('user-a');
    // A tick save in this session drains on its own, and must not send A's write.
    await drainMutationQueue(db, firstLaunch.queryClient, sendThroughAppClient);
    expect(network.sent).toEqual([]);
    expect(await outbox()).toEqual([untouched(A_TICK_UUID)]);

    // Reported once, by reason, with no account ids.
    expect(holdReports()).toEqual(['wipe-failed']);
    const [error, context] = reportHandledErrorMock.mock.calls[0] as [Error, { tags: Record<string, string> }];
    expect(context.tags).toEqual({ source: 'offline-sync', op: 'owner-claim-hold', reason: 'wipe-failed' });
    expect(JSON.stringify([error.message, context])).not.toMatch(/user-a|user-b/);

    firstLaunch.view.unmount();

    // The next launch: a fresh process, the lock gone. Nothing about the hold
    // was persisted, so the claim runs from scratch and completes.
    __resetSyncSchedulerStateForTests();
    __resetDrainerStateForTests();
    faults.lockTransactions = false;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const secondLaunch = render(<Harness queryClient={queryClient} />);

    await waitFor(async () => expect(await getLocalUserId(db)).toBe('user-b'));
    expect(await getPendingCount(db)).toBe(0);
    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    await settle();
    expect(sentTickUuids()).toEqual([]);

    secondLaunch.unmount();
  });

  it("reports the next account's failed wipe too, after a sign-out", async () => {
    // A lapsed account Z left its rows; the database stays locked through two
    // sign-ins. Each sign-in's hold is its own event: once per sign-in, not per process.
    await runMigrations(db);
    await stampLocalUserId(db, 'user-z');
    await enqueue(db, 'boardsesh_ticks', 'create', tickInput("Z's send"), A_TICK_UUID);
    faults.lockTransactions = true;

    const app = await launch();
    await signIn(app, 'user-a');
    await waitFor(() => expect(holdReports()).toEqual(['wipe-failed']));

    // A forced sign-out: its own wipe hits the same lock, which the real cleanup
    // swallows, and the query cache goes.
    auth.token = null;
    app.queryClient.clear();
    auth.isAuthenticated = false;
    await act(async () => {
      app.view.rerender(<Harness queryClient={app.queryClient} />);
    });
    await settle();

    await signIn(app, 'user-b');
    await waitFor(() => expect(holdReports()).toEqual(['wipe-failed', 'wipe-failed']));
    expect(schedulerStarts).toEqual([]);
    expect(network.sent).toEqual([]);
    expect(await getLocalUserId(db)).toBe('user-z');

    app.view.unmount();
  });

  it('holds sync when the token names nobody, and says so once', async () => {
    await seedAccountAOutbox();

    const app = await launch();
    await signIn(app, NO_SUB);
    await settle();
    await foreground();

    expect(schedulerStarts).toEqual([]);
    expect(network.sent).toEqual([]);
    expect(await getLocalUserId(db)).toBe('user-a');
    expect(holdReports()).toEqual(['no-user-id']);

    app.view.unmount();
  });
});

/** The same file on a new connection object, as a dead-handle recovery publishes it. */
function replacementConnection(onStampRead?: () => void): TestSqliteDb & SQLiteDatabase {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'getFirstAsync' && onStampRead) {
        return async <T,>(source: string, ...params: (string | number | null)[]): Promise<T | null> => {
          if (JSON.stringify(params).includes(LOCAL_USER_ID_KEY)) onStampRead();
          return target.getFirstAsync<T>(source, ...params);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as TestSqliteDb & SQLiteDatabase;
}

async function rerenderApp({ view, queryClient }: App): Promise<void> {
  await act(async () => {
    view.rerender(<Harness queryClient={queryClient} />);
  });
}

// A retry is requested by a failed claim and consumed by the next attempt,
// whatever started it. A claim that re-runs for another reason (a replacement
// connection after a dead-handle recovery, #5410) must not leave the request
// behind for the next foreground (review of #6825).
describe('OfflineSyncBridge: a retry request does not outlive the next attempt', () => {
  it('a foreground does not re-run a claim that already succeeded', async () => {
    await runMigrations(db);
    const app = await launch();
    // First attempt fails without deciding anything: credentials still settling.
    auth.token = null;
    auth.isAuthenticated = true;
    await rerenderApp(app);
    await settle();
    expect(schedulerStarts).toEqual([]);

    // The connection is replaced; the claim re-runs on it (not a retry) and succeeds.
    auth.token = 'user-b';
    let stampReads = 0;
    database.current = replacementConnection(() => {
      stampReads += 1;
    });
    await rerenderApp(app);
    await waitFor(() => expect(schedulerStarts).toHaveLength(1));
    await settle();
    const readsBefore = stampReads;

    await foreground();
    expect(stampReads - readsBefore).toBe(0);

    app.view.unmount();
  });

  it('a failed wipe stays held on the next foreground even after an earlier failed attempt', async () => {
    await seedAccountAOutbox();
    const app = await launch();
    auth.token = null;
    auth.isAuthenticated = true;
    await rerenderApp(app);
    await settle();
    expect(holdReports()).toEqual([]);

    // Replacement connection: B's token now reads, and the owner wipe hits a lock.
    auth.token = 'user-b';
    faults.lockTransactions = true;
    database.current = replacementConnection();
    await rerenderApp(app);
    await waitFor(() => expect(holdReports()).toEqual(['wipe-failed']));

    // A failed wipe holds the session: a foreground does not retry it.
    faults.lockTransactions = false;
    await foreground();
    expect({ stamp: await getLocalUserId(db), schedulerStarts: schedulerStarts.length }).toEqual({
      stamp: 'user-a',
      schedulerStarts: 0,
    });

    app.view.unmount();
  });
});
