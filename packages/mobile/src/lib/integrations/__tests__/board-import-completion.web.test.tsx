// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_SESSION_DETAIL } from '@boardsesh/graphql/operations';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
const state = vi.hoisted(() => ({
  required: true,
  legacy: false,
  anonymous: false,
  unavailable: false,
  user: 'A',
  sid: 'login-A',
  version: 2,
  generation: 1,
}));
vi.mock('../../browser-consumer-readiness.web', () => ({ publicExpoBrowserConsumersReady: () => state.required }));
vi.mock('../../browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: vi.fn(async () => {}) }));
vi.mock('../../auth-interceptor', () => ({
  authenticatedFetch: (...args: Parameters<typeof import('../../auth-interceptor.web').authenticatedFetch>) =>
    runtime.interceptor.authenticatedFetch(...args),
}));
vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../env', () => ({
  BACKEND_URL: 'https://backend.owned.test/',
  WEB_BASE_URL: 'https://www.owned.test',
  webApiUrl: (path: string) => 'https://www.owned.test' + path,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'rest-owned' } } }));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
let runtime: {
  reads: typeof import('../use-board-account-reads');
  credentials: typeof import('../use-board-account-credentials');
  poll: typeof import('../use-pending-board-sync-poll');
  watcher: typeof import('../board-import-completion');
  privacy: typeof import('../../privacy/privacy-cache');
  reporting: typeof import('../../error-reporting');
  detail: typeof import('../../graphql/hooks/use-session-detail');
  operations: typeof import('../../graphql/http-operation.web');
  operationScope: typeof import('../../graphql/use-http-operation-scope.web');
  authToken: typeof import('../../graphql/use-auth-token.web');
  requestScope: typeof import('../../graphql/request-scope.web');
  store: typeof import('../../auth-store.web');
  rest: typeof import('../../rest-operation.web');
  backend: typeof import('../../browser-backend-client.web');
  clients: typeof import('../../graphql/client.web');
  interceptor: typeof import('../../auth-interceptor.web');
  admission: typeof import('../../browser-response-admission.web');
};
let cache: QueryClient;
const auth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false, reason: null }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../rest-operation', () => ({
  createRestOperation: (...args: Parameters<typeof import('../../rest-operation.web').createRestOperation>) =>
    runtime.rest.createRestOperation(...args),
  useRestView: () => runtime.rest.useRestView(),
  captureRestReadView: () => runtime.rest.captureRestReadView(),
}));
vi.mock('../../graphql/http-operation', () => ({
  createHttpOperation: (...args: Parameters<typeof import('../../graphql/http-operation.web').createHttpOperation>) =>
    runtime.operations.createHttpOperation(...args),
}));
vi.mock('../../graphql/use-http-operation-scope', () => ({
  useHttpOperationScope: () => runtime.operationScope.useHttpOperationScope(),
  isHttpCacheScoped: () => runtime.operationScope.isHttpCacheScoped(),
}));
vi.mock('../../graphql/use-auth-token', () => ({ useAuthToken: () => runtime.authToken.useAuthToken() }));
vi.mock('../../graphql/request-scope', () => ({
  isCurrentHttpView: (scope: string | undefined) => runtime.requestScope.isCurrentHttpView(scope),
  httpScopeQueryKey: (logical: readonly unknown[], scope: string | undefined) =>
    runtime.requestScope.httpScopeQueryKey(logical, scope),
}));
let releases: (() => void)[];
let sdkPackets: number;
let clock: number;
let serial: number;
let packets: { url: string; init?: RequestInit }[];
let leases: Map<string, BrowserBackendLeaseOwner>;
let reply: () => Promise<Response>;
let sessionReply: (() => Promise<Response>) | undefined;
function owner(): BrowserBackendLeaseOwner {
  return {
    userId: state.user,
    authSessionId: state.sid,
    generation: state.generation,
    cursor: { bindingId: 'a'.repeat(64), version: state.version },
  };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function admit() {
  await runtime.store.synchronizeWebSession();
}
async function change(kind: string) {
  if (kind === 'B') {
    state.user = 'B';
    state.sid = 'login-B';
  }
  if (kind === 'ABA') {
    state.user = 'B';
    state.sid = 'login-B';
    await admit();
    state.user = 'A';
    state.sid = 'login-A';
  }
  if (kind === 'SID') state.sid = 'login-A-next';
  if (kind === 'generation') state.generation++;
  if (kind === 'version') state.version++;
  await admit();
}
beforeEach(async (context) => {
  vi.resetModules();
  Object.assign(state, {
    required: true,
    legacy: false,
    anonymous: false,
    unavailable: false,
    user: 'A',
    sid: 'login-A',
    version: 2,
    generation: 1,
  });
  if (context.task.name.startsWith('wholly legacy')) {
    state.required = false;
    state.legacy = true;
  }
  clock = 0;
  serial = 0;
  releases = [];
  sdkPackets = 0;
  packets = [];
  leases = new Map();
  sessionReply = undefined;
  reply = async () => Response.json({ credentials: [credential(state.user)] });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/auth/session')) {
        if (sessionReply) return sessionReply();
        if (state.unavailable) return Response.json({}, { status: 503 });
        if (state.anonymous) return Response.json({});
        return Response.json({
          user: { id: state.user },
          authSessionId: state.sid,
          ...(!state.legacy
            ? { authGeneration: state.generation, browserSelection: owner(), expires: '2099-01-01T00:00:00.000Z' }
            : {}),
        });
      }
      if (url.endsWith('/api/internal/ws-auth')) {
        if (state.legacy)
          return Response.json({
            authenticated: true,
            token: `legacy-${++serial}`,
            userId: state.user,
            authSessionId: state.sid,
          });
        const token = `bsbd1_REST_${++serial}`;
        leases.set(token, owner());
        return Response.json({ status: 'admitted', token, usableForMs: 120000, owner: owner() });
      }
      if (url.endsWith('/api/auth/csrf')) return Response.json({ csrfToken: 'owned-csrf' });
      if (url.endsWith('/api/auth/signout')) return Response.json({ url: '/app' });
      if (url.endsWith('/graphql')) {
        sdkPackets++;
        return Response.json({ data: { sessionDetail: { sessionId: 'session-C', marker: state.user } } });
      }
      if (!url.startsWith('https://backend.owned.test/api/aurora-credentials'))
        throw new Error('Unexpected owned destination');
      packets.push({ url, init });
      return reply();
    }),
  );
  const store = await import('../../auth-store.web');
  const rest = await import('../../rest-operation.web');
  runtime = {
    store,
    rest,
    reads: await import('../use-board-account-reads'),
    credentials: await import('../use-board-account-credentials'),
    poll: await import('../use-pending-board-sync-poll'),
    watcher: await import('../board-import-completion'),
    privacy: await import('../../privacy/privacy-cache'),
    reporting: await import('../../error-reporting'),
    detail: await import('../../graphql/hooks/use-session-detail'),
    operations: await import('../../graphql/http-operation.web'),
    operationScope: await import('../../graphql/use-http-operation-scope.web'),
    authToken: await import('../../graphql/use-auth-token.web'),
    requestScope: await import('../../graphql/request-scope.web'),
    backend: await import('../../browser-backend-client.web'),
    clients: await import('../../graphql/client.web'),
    interceptor: await import('../../auth-interceptor.web'),
    admission: await import('../../browser-response-admission.web'),
  };
  vi.mocked(runtime.reporting.reportHandledError).mockReset();
  await admit();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000 } } });
  auth.isAuthenticated = true;
});
afterEach(() => {
  for (const release of releases) release();
  cleanup();
  cache?.clear();
  vi.useRealTimers();
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function credential(user: string, pendingRunId: string | null = null) {
  return {
    boardType: 'tension',
    auroraUsername: 'private-' + user,
    auroraUserId: 42,
    lastSyncAt: null,
    syncStatus: 'synced',
    syncError: null,
    pendingRunId,
    createdAt: '2026-01-01T00:00:00Z',
  };
}
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: cache }, children);
}
function key(scope: string | undefined, logical: readonly unknown[] = ['auroraCredentials']) {
  return [...runtime.clients.browserHttpClients.queryKey([], scope), ...logical];
}

const roots = [
  'userTicks',
  'userProfileStats',
  'userClimbPercentile',
  'userAscentsFeed',
  'userGroupedAscentsFeed',
  'logbook',
  'climb',
  'searchClimbs',
  'infiniteSearchClimbs',
  'searchClimbsCount',
  'sessionGroupedFeed',
  'sessionDetail',
  'tickBoardOptions',
  'board',
  'myBoards',
  'boardBySlug',
  'activityFeed',
  'crewFeed',
  'betaLinks',
  'userTickCountsByBoard',
  'userPlaylists',
  'playlistClimbs',
];
function watch() {
  const release = runtime.watcher.watchBoardImportCompletion(cache);
  releases.push(release);
  return release;
}
function observe(listener: Parameters<typeof runtime.reads.subscribeToAcceptedBoardAccountReads>[1]) {
  const release = runtime.reads.subscribeToAcceptedBoardAccountReads(cache, listener);
  releases.push(release);
  return release;
}
function read() {
  return renderHook(() => runtime.reads.useAuroraCredentialsRead(), { wrapper });
}
async function refetch(view: ReturnType<typeof read>) {
  await act(async () => {
    await view.result.current.refetch();
  });
}
function result(pending: string | null, syncAt: string | null = null) {
  return { credentials: [{ ...credential('A', pending), lastSyncAt: syncAt }] };
}
function seed(scope: string | undefined) {
  for (const root of roots) cache.setQueryData(key(scope, [root, 'target-C']), { cached: root });
}

describe('selected import observation ownership', () => {
  it('same function re-registration skips old observation and receives next actual GET', async () => {
    const same = vi.fn();
    let stopSame = () => {};
    let replace = true;
    observe(() => {
      if (!replace) return;
      replace = false;
      stopSame();
      stopSame = observe(same);
    });
    stopSame = observe(same);
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
    expect(same).toHaveBeenCalledTimes(0);
    await refetch(view);
    expect(packets).toHaveLength(2);
    expect(same).toHaveBeenCalledTimes(1);
    expect(same.mock.contexts[0]).toBeUndefined();
  });
  it('duplicate same function registrations unsubscribe independently', async () => {
    const same = vi.fn();
    const first = observe(same);
    const second = observe(same);
    first();
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
    expect(same).toHaveBeenCalledTimes(1);
    second();
    await refetch(view);
    expect(packets).toHaveLength(2);
    expect(same).toHaveBeenCalledTimes(1);
  });

  it('a rejected enqueue promise is observed before post-call original expiry refuses', async () => {
    watch();
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const original = cache.invalidateQueries.bind(cache);
    const spy = vi.spyOn(cache, 'invalidateQueries').mockImplementation((filters, options) => {
      void original(filters, options);
      clock = 120001;
      return Promise.reject(new Error('PRIVATE secondary enqueue error'));
    });
    reply = async () => Response.json(result(null, '2026-02'));
    await refetch(view);
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.error).toMatchObject({ name: 'BrowserBackendConsumerError' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(runtime.reporting.reportHandledError).not.toHaveBeenCalled();
  });
  it('disabled scoped observer marks stale then actual SDK refetches only when enabled', async () => {
    watch();
    const view = runtime.rest.captureRestReadView();
    const targetKey = view.key(['sessionDetail', 'session-disabled']);
    cache.setQueryData(targetKey, { marker: 'cached-before-import' });
    const queryFn = async () => {
      const operation = runtime.operations.createHttpOperation(view.scope);
      const response = await operation.request<{ sessionDetail: { sessionId: string; marker: string } }>(
        GET_SESSION_DETAIL,
        { sessionId: 'session-disabled' },
      );
      operation.assertDeliveries();
      return response.sessionDetail;
    };
    const observer = new QueryObserver(cache, {
      queryKey: targetKey,
      queryFn,
      enabled: false,
      staleTime: 30 * 60 * 1000,
    });
    releases.push(observer.subscribe(() => {}));
    reply = async () => Response.json(result('run'));
    const credentials = read();
    await waitFor(() => expect(credentials.result.current.isSuccess).toBe(true));
    reply = async () => Response.json(result(null, '2026-02'));
    await refetch(credentials);
    expect(cache.getQueryState(targetKey)?.isInvalidated).toBe(true);
    expect(sdkPackets).toBe(0);
    observer.setOptions({ queryKey: targetKey, queryFn, enabled: true, staleTime: 30 * 60 * 1000 });
    await waitFor(() => expect(sdkPackets).toBe(1));
    await waitFor(() => expect(cache.getQueryState(targetKey)?.isInvalidated).toBe(false));
    expect(observer.getCurrentResult().data).toEqual({ sessionId: 'session-C', marker: 'A' });
  });

  it('pending original body cannot notify after expiry even with an independent fresh same-view lease', async () => {
    const held = deferred<void>();
    const seen = vi.fn();
    observe(seen);
    watch();
    reply = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(result('retired-run'))));
            await held.promise;
            controller.close();
          },
        }),
      );
    const view = read();
    await waitFor(() => expect(packets).toHaveLength(1));
    clock = 120001;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    await act(async () => {
      held.resolve();
    });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(seen).not.toHaveBeenCalled();
    const freshScope = runtime.backend.expoBrowserBackendClient.capture(fresh.token);
    expect(freshScope).not.toBeNull();
    if (freshScope) runtime.backend.expoBrowserBackendClient.assertCurrent(freshScope, fresh);
    const spy = vi.spyOn(cache, 'invalidateQueries');
    reply = async () => Response.json(result(null, '2026-06'));
    await refetch(view);
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(spy).not.toHaveBeenCalled();
  });

  it('actual pending then finished read enqueues exactly22 original roots once', async () => {
    const scope = runtime.rest.captureRestReadView().scope;
    seed(scope);
    watch();
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const spy = vi.spyOn(cache, 'invalidateQueries');
    reply = async () => Response.json(result(null, '2026-02'));
    await refetch(view);
    expect(spy).toHaveBeenCalledTimes(22);
    expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(roots.map((root) => key(scope, [root])));
    for (const root of roots) expect(cache.getQueryState(key(scope, [root, 'target-C']))?.isInvalidated).toBe(true);
    await refetch(view);
    expect(spy).toHaveBeenCalledTimes(22);
  });
  it('mode/cache observation performs no token I/O and shared observers publish once', async () => {
    const seen = vi.fn();
    observe(seen);
    watch();
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(runtime.rest.captureRestReadView().mode).toBe('selected');
    renderHook(
      () => {
        runtime.poll.usePendingBoardSyncPoll();
        runtime.credentials.useBoardAccountCredentials(false);
      },
      { wrapper },
    );
    await act(async () => {});
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(packets).toHaveLength(1);
  });
  it('immutable minimal projection isolates later listeners and the returned raw DTO', async () => {
    type Observation = Parameters<Parameters<typeof runtime.reads.subscribeToAcceptedBoardAccountReads>[1]>[0];
    const probes: {
      observation: Observation;
      initialEntry: unknown;
      entryExists: boolean;
      frozen: { event: boolean; array: boolean; entry: boolean; key: boolean };
      fields: string[];
      beforePending: string | null | undefined;
      afterPending: string | null | undefined;
      entryMutation: boolean;
      arrayMutation: boolean;
    }[] = [];
    const stopMutation = observe((event) => {
      const entry = event.snapshot[0];
      const initialKey = event.key([]);
      const frozen = {
        event: Object.isFrozen(event),
        array: Object.isFrozen(event.snapshot),
        entry: Object.isFrozen(entry),
        key: Object.isFrozen(initialKey),
      };
      const fields = Object.keys(entry ?? {});
      const beforePending = entry?.pendingRunId;
      const entryMutation = Reflect.set(entry ?? {}, 'pendingRunId', 'MUTATED subscriber status');
      const arrayMutation = Reflect.set(event.snapshot, 'length', 0);
      probes.push({
        observation: event,
        initialEntry: entry,
        entryExists: entry !== undefined,
        frozen,
        fields,
        beforePending,
        afterPending: entry?.pendingRunId,
        entryMutation,
        arrayMutation,
      });
    });
    watch();
    const laterSnapshots: { length: number; pending: string | null | undefined }[] = [];
    observe((event) => {
      laterSnapshots.push({ length: event.snapshot.length, pending: event.snapshot[0]?.pendingRunId });
    });
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    // Assertions run outside publisher-owned callbacks; consumer isolation cannot swallow them.
    const probe = probes[0];
    if (!probe) throw new Error('Actual selected observation was not captured');
    const rawCredentials = view.result.current.data?.credentials;
    if (!rawCredentials?.[0]) throw new Error('Actual fresh raw query DTO was not returned');
    expect({
      laterInputs: laterSnapshots,
      mutationResults: { entry: probe.entryMutation, array: probe.arrayMutation },
      beforePending: probe.beforePending,
      afterPending: probe.afterPending,
      frozen: probe.frozen,
      fields: probe.fields,
      entryExists: probe.entryExists,
      snapshotIsRawArray: rawCredentials === probe.observation.snapshot,
      snapshotIsRawEntry: rawCredentials[0] === probe.initialEntry,
      rawArrayFrozen: Object.isFrozen(rawCredentials),
      rawEntryFrozen: Object.isFrozen(rawCredentials[0]),
      rawUsername: rawCredentials[0].auroraUsername,
      rawPending: rawCredentials[0].pendingRunId,
      observations: probes.length,
      packets: packets.length,
      reports: vi.mocked(runtime.reporting.reportHandledError).mock.calls.length,
    }).toEqual({
      laterInputs: [{ length: 1, pending: 'run' }],
      mutationResults: { entry: false, array: false },
      beforePending: 'run',
      afterPending: 'run',
      frozen: { event: true, array: true, entry: true, key: true },
      fields: ['boardType', 'pendingRunId', 'lastSyncAt'],
      entryExists: true,
      snapshotIsRawArray: false,
      snapshotIsRawEntry: false,
      rawArrayFrozen: false,
      rawEntryFrozen: false,
      rawUsername: 'private-A',
      rawPending: 'run',
      observations: 1,
      packets: 1,
      reports: 0,
    });
    expect(Reflect.set(rawCredentials[0], 'pendingRunId', 'raw-only status')).toBe(true);
    expect(probe.observation.snapshot[0]?.pendingRunId).toBe('run');
    expect(runtime.reporting.reportHandledError).not.toHaveBeenCalled();

    // Separate ordinary-consumer failure phase, after immutable observations are verified.
    stopMutation();
    observe(() => {
      throw new Error('PRIVATE ordinary subscriber cause');
    });
    await refetch(view);
    await waitFor(() => expect(runtime.reporting.reportHandledError).toHaveBeenCalledTimes(1));
    expect(view.result.current.isSuccess).toBe(true);
    expect(packets).toHaveLength(2);
    expect(view.result.current.data?.credentials[0]?.pendingRunId).toBe('run');
    expect(laterSnapshots).toEqual([
      { length: 1, pending: 'run' },
      { length: 1, pending: 'run' },
    ]);
    expect(runtime.reporting.reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Board import notification consumer failed' }),
    );
  });
  it.each([403, 429, 500])('HTTP%s retains primary failure and emits no status', async (status) => {
    const seen = vi.fn();
    observe(seen);
    watch();
    reply = async () => Response.json({ error: 'PRIVATE error' }, { status });
    const view = read();
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(seen).not.toHaveBeenCalled();
    expect(view.result.current.error?.name).toBe('BoardAccountError');
  });
  it('decode and unknown network errors retain primary failure without notifying', async () => {
    const seen = vi.fn();
    observe(seen);
    watch();
    reply = async () => new Response('{');
    const view = read();
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.error).toBeInstanceOf(SyntaxError);
    reply = async () => {
      throw new Error('owned offline failure');
    };
    await refetch(view);
    await waitFor(() => expect(view.result.current.error?.message).toBe('owned offline failure'));
    expect(seen).not.toHaveBeenCalled();
  });
  it('raw/copy/foreign/unsynced cache data cannot manufacture selected history', async () => {
    watch();
    const spy = vi.spyOn(cache, 'invalidateQueries');
    const scope = runtime.rest.captureRestReadView().scope;
    for (const physical of [
      ['auroraCredentials'],
      key(scope),
      key('bshv1_foreign'),
      key(scope, ['auroraCredentials', 'unsynced']),
    ]) {
      cache.setQueryData(physical, result('run'));
      cache.setQueryData(physical, result(null, '2026-02'));
    }
    expect(spy).not.toHaveBeenCalled();
    reply = async () => Response.json(result(null, '2026-02'));
    const view = read();
    await act(async () => {
      await view.result.current.refetch();
    });
    expect(spy).not.toHaveBeenCalled();
  });
  it('unknown required mode refuses raw poison with no GET', async () => {
    await runtime.store.clearTokens();
    watch();
    const spy = vi.spyOn(cache, 'invalidateQueries');
    cache.setQueryData(['auroraCredentials'], result('run'));
    cache.setQueryData(['auroraCredentials'], result(null, '2026-02'));
    const view = read();
    await act(async () => {});
    expect(view.result.current.data).toBeUndefined();
    expect(packets).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
  it('actual anonymous401 is never selected status or empty success', async () => {
    state.anonymous = true;
    await admit();
    const seen = vi.fn();
    observe(seen);
    watch();
    reply = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
    const view = read();
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.error).toMatchObject({ code: 'unauthorized' });
    expect(seen).not.toHaveBeenCalled();
  });
  it.each(['B', 'ABA', 'SID', 'generation', 'version'])(
    'newview starts first observation without consuming A completion: %s',
    async (kind) => {
      watch();
      reply = async () => Response.json(result('run-A'));
      const view = read();
      await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
      const spy = vi.spyOn(cache, 'invalidateQueries');
      reply = async () => Response.json(result(null, '2026-02'));
      await act(async () => {
        await change(kind);
      });
      await waitFor(() => expect(view.result.current.data?.credentials[0]?.pendingRunId).toBeNull());
      expect(spy).not.toHaveBeenCalled();
    },
  );
  it('partial original expiry keeps history; identical fresh same-view finish retries22', async () => {
    const scope = runtime.rest.captureRestReadView().scope;
    seed(scope);
    watch();
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const original = cache.invalidateQueries.bind(cache);
    let expire = true;
    const spy = vi.spyOn(cache, 'invalidateQueries').mockImplementation((filters, options) => {
      const pending = original(filters, options);
      if (expire) {
        expire = false;
        clock = 120001;
      }
      return pending;
    });
    reply = async () => Response.json(result(null, '2026-02'));
    await refetch(view);
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cache.getQueryState(key(scope))?.error).toMatchObject({ name: 'BrowserBackendConsumerError' });
    expect(
      cache.getQueryData<{ credentials: { pendingRunId: string }[] }>(key(scope))?.credentials[0]?.pendingRunId,
    ).toBe('run');
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    expect(fresh.token).toBeTruthy();
    await refetch(view);
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledTimes(23);
    expect(spy.mock.calls.slice(1).map(([filters]) => filters?.queryKey)).toEqual(
      roots.map((root) => key(scope, [root])),
    );
    await refetch(view);
    expect(spy).toHaveBeenCalledTimes(23);
  });
  it.each(['privacy', 'unsubscribe'])('first enqueue %s stops effects and history resurrection', async (kind) => {
    const stop = watch();
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const original = cache.invalidateQueries.bind(cache);
    let interrupt = true;
    const spy = vi.spyOn(cache, 'invalidateQueries').mockImplementation((filters, options) => {
      const pending = original(filters, options);
      if (interrupt) {
        interrupt = false;
        if (kind === 'privacy') runtime.privacy.invalidateCredentialSnapshots();
        else stop();
      }
      return pending;
    });
    reply = async () => Response.json(result(null, '2026-02'));
    await refetch(view);
    expect(spy).toHaveBeenCalledTimes(1);
    await refetch(view);
    expect(spy).toHaveBeenCalledTimes(1);
    if (kind === 'privacy') {
      reply = async () => Response.json(result('new-run', '2026-02'));
      await refetch(view);
      reply = async () => Response.json(result(null, '2026-03'));
      await refetch(view);
      expect(spy).toHaveBeenCalledTimes(23);
    }
  });
  it('accepted history survives GC/background and ordinary same-view renewal', async () => {
    watch();
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    view.unmount();
    const scope = runtime.rest.captureRestReadView().scope;
    cache.removeQueries({ queryKey: key(scope), exact: true });
    clock = 600001;
    await runtime.backend.expoBrowserBackendClient.acquire(owner());
    const spy = vi.spyOn(cache, 'invalidateQueries');
    reply = async () => Response.json(result(null, '2026-04'));
    const resumed = read();
    await waitFor(() => expect(resumed.result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledTimes(22);
  });
  it('actual20second poll completes and disabled scoped targets become stale without a fetch', async () => {
    watch();
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const scope = runtime.rest.captureRestReadView().scope;
    seed(scope);
    view.unmount();
    vi.useFakeTimers();
    const spy = vi.spyOn(cache, 'invalidateQueries');
    reply = async () => Response.json(result(null, '2026-05'));
    renderHook(() => runtime.poll.usePendingBoardSyncPoll(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19999);
    });
    expect(packets).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(packets).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(22);
    expect(cache.getQueryState(key(scope, ['userTicks', 'target-C']))?.isInvalidated).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(packets).toHaveLength(2);
  });
  it('actual adopted session detail SDK observer refetches after original import completion', async () => {
    watch();
    const detail = renderHook(() => runtime.detail.useSessionDetail('session-C'), { wrapper });
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    const before = sdkPackets;
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    reply = async () => Response.json(result(null, '2026-05'));
    await refetch(view);
    await waitFor(() => expect(sdkPackets).toBe(before + 1));
    expect(detail.result.current.data).toEqual({ sessionId: 'session-C', marker: 'A' });
  });
  it('retiring A in first subscriber suppresses later listener, reporter and raw publication', async () => {
    let entered = false;
    observe(() => {
      entered = true;
      runtime.backend.expoBrowserBackendClient.retire();
      throw new Error('PRIVATE retired cause');
    });
    const later = vi.fn();
    observe(later);
    watch();
    const originalKey = key(runtime.rest.captureRestReadView().scope);
    const view = read();
    await waitFor(() => expect(entered).toBe(true));
    await act(async () => {});
    expect(runtime.rest.captureRestReadView().ready).toBe(false);
    expect(later).not.toHaveBeenCalled();
    expect(runtime.reporting.reportHandledError).not.toHaveBeenCalled();
    expect(view.result.current.data).toBeUndefined();
    expect(cache.getQueryData(originalKey)).toBeUndefined();
    expect(packets).toHaveLength(1);
  });
  it('reporter retirement stops later fanout and old query publication', async () => {
    observe(() => {
      throw new Error('PRIVATE listener cause');
    });
    const later = vi.fn();
    observe(later);
    vi.mocked(runtime.reporting.reportHandledError).mockImplementationOnce(() => {
      runtime.backend.expoBrowserBackendClient.retire();
    });
    const originalKey = key(runtime.rest.captureRestReadView().scope);
    const view = read();
    await waitFor(() => expect(runtime.reporting.reportHandledError).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(runtime.rest.captureRestReadView().ready).toBe(false);
    expect(later).not.toHaveBeenCalled();
    expect(runtime.reporting.reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Board import notification consumer failed' }),
    );
    expect(view.result.current.data).toBeUndefined();
    expect(cache.getQueryData(originalKey)).toBeUndefined();
    expect(packets).toHaveLength(1);
  });
  it('idempotent unsubscribe cannot delete a newer subscriber set', async () => {
    const first = vi.fn();
    const stop = observe(first);
    stop();
    const second = vi.fn();
    observe(second);
    stop();
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
  it('new listeners wait for next observation and removed listeners are skipped', async () => {
    const added = vi.fn();
    const removed = vi.fn();
    let stopRemoved = () => {};
    observe(() => {
      stopRemoved();
      observe(added);
    });
    stopRemoved = observe(removed);
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(removed).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
    await refetch(view);
    expect(added).toHaveBeenCalledTimes(1);
  });
  it('clients are isolated and nonprimitive projection never supplies status', async () => {
    const other = new QueryClient();
    const seen = vi.fn();
    const stop = runtime.reads.subscribeToAcceptedBoardAccountReads(other, seen);
    releases.push(() => {
      stop();
      other.clear();
    });
    const local = vi.fn();
    observe(local);
    reply = async () => Response.json({ credentials: [{ ...credential('A'), pendingRunId: { PRIVATE: true } }] });
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(local).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
    expect(view.result.current.data?.credentials).toHaveLength(1);
  });
  it('wholly legacy retains raw watcher behavior without selected double notification', async () => {
    const seen = vi.fn();
    observe(seen);
    watch();
    reply = async () => Response.json(result('run'));
    const view = read();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const spy = vi.spyOn(cache, 'invalidateQueries');
    reply = async () => Response.json(result(null, '2026-02'));
    await refetch(view);
    expect(spy).toHaveBeenCalledTimes(22);
    expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(roots.map((root) => [root]));
    expect(seen).not.toHaveBeenCalled();
  });
});
