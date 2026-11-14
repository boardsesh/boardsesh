// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';

const database = vi.hoisted(() => ({}));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => database }));
vi.mock('../../offline-engine', () => ({ isOfflineEngineEnabled: () => true }));
vi.mock('../offline-user-operations', () => ({ registerOfflineUserOperations: () => {} }));
vi.mock('../offline-user-read-recovery', () => ({ recordLocalUserRead: () => {} }));
vi.mock('../../../offline/offline-usage-signal', () => ({
  recordOfflineRead: () => {},
  recordOfflineReadUnavailable: () => {},
}));
vi.mock('../../local-user-id', () => ({ readLocalUserId: async () => 'owned-A' }));
vi.mock('@boardsesh/offline-sync', () => ({
  assertLocalUserDataOwner: async () => 'ok',
  canServeLocalUserData: async () => true,
  ensureHoldIndex: async () => {},
}));
vi.mock('../client', () => ({
  getHttpClient: (...parameters: [scope?: string | null]) => active().clients.getHttpClient(...parameters),
}));
vi.mock('../../auth-interceptor', () => ({
  authenticatedFetch: (input: string | URL | Request, init?: RequestInit) =>
    active().interceptor.authenticatedFetch(input, init),
}));
vi.mock('../request-scope', () => ({
  captureHttpRequestScope: (...parameters: [scope?: string | null]) =>
    active().scope.captureHttpRequestScope(...parameters),
  assertCurrentHttpResult: (scope: string | undefined, result: unknown) =>
    active().scope.assertCurrentHttpResult(scope, result),
}));
vi.mock('../../browser-consumer-readiness.web', () => ({ publicExpoBrowserConsumersReady: () => true }));
vi.mock('../../browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: vi.fn(async () => {}) }));
vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('../../env', () => ({
  BACKEND_URL: 'https://backend.owned.test',
  WEB_BASE_URL: 'https://www.owned.test',
  webApiUrl: (path: string) => 'https://www.owned.test' + path,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'owned-fixture' } } }));

type Runtime = {
  store: typeof import('../../auth-store.web');
  clients: typeof import('../client.web');
  backend: typeof import('../../browser-backend-client.web');
  scope: typeof import('../request-scope.web');
  offline: typeof import('../offline-request');
  interceptor: typeof import('../../auth-interceptor.web');
};
let runtime: Runtime | undefined;
let clock: number;
let packets: number;
let unregister: (() => void) | undefined;
const document = 'query OwnedLocal { ownedLocal { owner } }';
const actor = {
  userId: 'owned-A',
  authSessionId: 'owned-login-A',
  generation: 1,
  cursor: { bindingId: 'a'.repeat(64), version: 2 },
};
function active(): Runtime {
  if (!runtime) throw new Error('Owned browser runtime is not initialized');
  return runtime;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetModules();
  runtime = undefined;
  unregister = undefined;
  clock = 0;
  packets = 0;
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  onlineManager.setOnline(true);
  let issued = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<(...parameters: unknown[]) => Promise<Response>>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith('/api/auth/session'))
        return Response.json({
          user: { id: actor.userId },
          authSessionId: actor.authSessionId,
          authGeneration: actor.generation,
          expires: '2099-01-01T00:00:00.000Z',
          browserSelection: actor,
        });
      if (url.endsWith('/api/internal/ws-auth'))
        return Response.json({
          status: 'admitted',
          token: `bsbd1_OWNED${++issued}`,
          usableForMs: 120_000,
          owner: actor,
        });
      if (!url.endsWith('/graphql')) throw new Error('Unexpected owned fixture URL');
      packets += 1;
      return Response.json({ data: { ownedLocal: { owner: actor.userId } } });
    }),
  );
});
afterEach(() => {
  unregister?.();
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function start(): Promise<Runtime> {
  const store = await import('../../auth-store.web');
  expect(await store.synchronizeWebSession()).toMatchObject({ status: 'authenticated' });
  const clients = await import('../client.web');
  const backend = await import('../../browser-backend-client.web');
  const scope = await import('../request-scope.web');
  const interceptor = await import('../../auth-interceptor.web');
  const offline = await import('../offline-request');
  return (runtime = { store, clients, backend, scope, offline, interceptor });
}

describe('actual offline-aware request and original browser delivery', () => {
  it('a local-reader await cannot adopt a new same-tuple admission for the eventual network request', async () => {
    const current = await start();
    const entered = deferred();
    const release = deferred();
    unregister = current.offline.registerOfflineOperationForTests({
      document,
      surface: 'climb_detail',
      boardNameOf: () => 'kilter',
      async canServeLocal() {
        entered.resolve();
        await release.promise;
        return false;
      },
      resolveLocal: async () => null,
    });
    const generation = current.store.captureAuthCredentialGeneration();
    const pending = current.offline.offlineAwareRequest(document, {});
    const rejected = expect(pending).rejects.toMatchObject({ status: 'superseded' });
    await entered.promise;
    current.backend.expoBrowserBackendClient.retire();
    await current.store.synchronizeWebSession();
    expect(current.store.captureAuthCredentialGeneration()).toBe(generation);
    release.resolve();
    await rejected;
    expect(packets).toBe(0);
  });

  it('checks the original network lease after the caller-owned local enrichment await', async () => {
    const current = await start();
    const entered = deferred();
    const release = deferred();
    unregister = current.offline.registerOfflineOperationForTests({
      document,
      surface: 'climb_detail',
      boardNameOf: () => 'kilter',
      canServeLocal: async () => false,
      resolveLocal: async () => null,
      async enrichNetworkResponse(_db, _variables, response) {
        entered.resolve();
        await release.promise;
        return response;
      },
    });
    const pending = current.offline.offlineAwareRequest(document, {});
    const rejected = expect(pending).rejects.toMatchObject({ status: 'superseded' });
    await entered.promise;
    clock = 120_000;
    release.resolve();
    await rejected;
    expect(packets).toBe(1);
    expect(current.store.captureConfirmedWebAuthIdentity()?.userId).toBe(actor.userId);
  });

  it('local offline identity can still answer without being promoted into network authority', async () => {
    const current = await start();
    current.backend.expoBrowserBackendClient.retire();
    unregister = current.offline.registerOfflineOperationForTests({
      document,
      surface: 'climb_detail',
      boardNameOf: () => 'kilter',
      canServeLocal: async () => true,
      resolveLocal: async () => ({ ownedLocal: { owner: actor.userId } }),
    });
    const result = await current.offline.offlineAwareRequest(document, {});
    expect(result).toEqual({ ownedLocal: { owner: actor.userId } });
    expect(packets).toBe(0);
    expect(current.store.captureConfirmedWebAuthIdentity()?.userId).toBe(actor.userId);
    expect(() =>
      current.clients.browserHttpClients.assertCurrentResult(current.scope.captureHttpRequestScope(), result),
    ).toThrow();
  });
});
