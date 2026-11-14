// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacySettings } from '@boardsesh/graphql/operations/privacy';

const state = vi.hoisted(() => ({
  required: true,
  profile: 'owned-A' as string | undefined,
  account: 'owned-A',
  legacy: false,
  unavailable: false,
}));
// resetModules creates a fresh actual runtime per case; mock factories remain
// cached. Forward to that runtime instead of retaining a disposed namespace.
vi.mock('../../client', () => ({
  getHttpClient: (...arguments_: [scope?: string | null]) => active().clients.getHttpClient(...arguments_),
}));
vi.mock('../../request-scope', () => ({
  assertCurrentHttpResult: (scope: string | undefined, result: unknown) =>
    active().scope.assertCurrentHttpResult(scope, result),
  isCurrentHttpView: (scope: string | undefined) => active().scope.isCurrentHttpView(scope),
  httpScopeQueryKey: (key: readonly unknown[], scope: string | undefined) =>
    active().scope.httpScopeQueryKey(key, scope),
}));
vi.mock('../../use-http-request-scope', () => ({
  useHttpRequestScope: () => active().scopeHook.useHttpRequestScope(),
}));
vi.mock('../../use-auth-token', () => ({ useAuthToken: () => active().auth.useAuthToken() }));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => active().store.captureAuthCredentialGeneration(),
  isAuthCredentialGenerationCurrent: (generation: number) =>
    active().store.isAuthCredentialGenerationCurrent(generation),
}));
vi.mock('../../../auth-interceptor', () => ({
  authenticatedFetch: (input: string | URL | Request, init?: RequestInit) =>
    active().interceptor.authenticatedFetch(input, init),
}));
vi.mock('../index', () => ({ useProfile: () => ({ data: { id: state.profile } }) }));
vi.mock('../../../browser-consumer-readiness.web', () => ({ publicExpoBrowserConsumersReady: () => state.required }));
vi.mock('../../../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('../../../env', () => ({
  BACKEND_URL: 'https://backend.owned.test',
  WEB_BASE_URL: 'https://www.owned.test',
  webApiUrl: (path: string) => 'https://www.owned.test' + path,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'owned-fixture' } } }));

const originalSettings: PrivacySettings = {
  enabled: true,
  isPrivate: false,
  privacyRevision: 1,
  defaultSessionAudience: 'public',
  anonymousOnForeignBoards: false,
};
type Runtime = {
  store: typeof import('../../../auth-store.web');
  clients: typeof import('../../client.web');
  backend: typeof import('../../../browser-backend-client.web');
  auth: typeof import('../../use-auth-token.web');
  roles: typeof import('../use-my-roles');
  privacy: typeof import('../use-privacy');
  scope: typeof import('../../request-scope.web');
  scopeHook: typeof import('../../use-http-request-scope.web');
  interceptor: typeof import('../../../auth-interceptor.web');
};
let runtime: Runtime | undefined;
let queryClient: QueryClient;
let clock: number;
let packets: { query: string; authorization: string | null }[];
let heldRoles: { response: Response; promise: Promise<void> } | undefined;

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
function owner() {
  return {
    userId: state.account,
    authSessionId: `login-${state.account}`,
    generation: 1,
    cursor: { bindingId: (state.account === 'owned-A' ? 'a' : 'b').repeat(64), version: 2 },
  };
}
beforeEach(() => {
  vi.resetModules();
  state.required = true;
  state.profile = 'owned-A';
  state.account = 'owned-A';
  state.legacy = false;
  state.unavailable = false;
  runtime = undefined;
  clock = 0;
  packets = [];
  heldRoles = undefined;
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let sequence = 0;
  const issued = new Map<string, string>();
  vi.stubGlobal(
    'fetch',
    vi.fn<(...parameters: unknown[]) => Promise<Response>>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const options = init as RequestInit | undefined;
      if (url.endsWith('/api/auth/session')) {
        if (state.unavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
        const current = owner();
        return Response.json({
          user: { id: current.userId },
          authSessionId: current.authSessionId,
          ...(!state.legacy
            ? { authGeneration: current.generation, browserSelection: current, expires: '2099-01-01T00:00:00.000Z' }
            : {}),
        });
      }
      if (url.endsWith('/api/internal/ws-auth')) {
        if (state.legacy)
          return Response.json({
            authenticated: true,
            token: 'legacy-owned-A',
            userId: state.account,
            authSessionId: owner().authSessionId,
          });
        const token = `bsbd1_OWNED${++sequence}`;
        issued.set(token, state.account);
        return Response.json({ status: 'admitted', token, usableForMs: 120_000, owner: owner() });
      }
      if (!url.endsWith('/graphql')) throw new Error('Unexpected owned fixture URL');
      const authorization = new Headers(options?.headers).get('Authorization');
      const account = issued.get(authorization?.slice('Bearer '.length) ?? '') ?? 'owned-A';
      if (typeof options?.body !== 'string') throw new Error('Owned GraphQL body must be JSON text');
      const payload = JSON.parse(options.body) as { query: string };
      packets.push({ query: payload.query, authorization });
      if (payload.query.includes('myRoles')) {
        const response = Response.json({
          data: { myRoles: [{ role: 'leader', boardType: account === 'owned-A' ? 'kilter' : 'tension' }] },
        });
        const hold = heldRoles;
        if (hold && account === 'owned-A') {
          await hold.promise;
          return hold.response;
        }
        return response;
      }
      if (payload.query.includes('updatePrivacySettings'))
        return Response.json({
          data: { updatePrivacySettings: { ...originalSettings, isPrivate: true, privacyRevision: 2 } },
        });
      if (payload.query.includes('privacySettings'))
        return Response.json({ data: { privacySettings: originalSettings } });
      throw new Error('Unexpected owned GraphQL operation');
    }),
  );
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function start(legacy = false): Promise<Runtime> {
  state.legacy = legacy;
  state.required = !legacy;
  const store = await import('../../../auth-store.web');
  const admission = await store.synchronizeWebSession();
  expect(admission.status).toBe('authenticated');
  const clients = await import('../../client.web');
  const backend = await import('../../../browser-backend-client.web');
  const auth = await import('../../use-auth-token.web');
  const scope = await import('../../request-scope.web');
  const scopeHook = await import('../../use-http-request-scope.web');
  const interceptor = await import('../../../auth-interceptor.web');
  const roles = await import('../use-my-roles');
  const privacy = await import('../use-privacy');
  return (runtime = { store, clients, backend, auth, roles, privacy, scope, scopeHook, interceptor });
}
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}
function labels(): string[] {
  return queryClient
    .getQueriesData({ queryKey: ['authToken'] })
    .flatMap(([, value]) => (typeof value === 'string' ? [value] : []));
}
async function changeAccount(current: Runtime, account: string) {
  state.account = account;
  state.profile = account;
  await current.store.synchronizeWebSession();
}

describe('actual web hook, SDK and React Query caller publication', () => {
  it('the unused raw selected API refuses before any backend packet', async () => {
    const current = await start();
    await expect(current.clients.graphqlFetchGated('https://backend.owned.test/graphql')).rejects.toMatchObject({
      status: 'unavailable',
    });
    expect(packets).toEqual([]);
  });
  it('stores only opaque labels and keeps a late A roles response out of B and ABA query identities', async () => {
    const current = await start();
    const release = deferred();
    heldRoles = {
      promise: release.promise,
      response: Response.json({ data: { myRoles: [{ role: 'leader', boardType: 'kilter' }] } }),
    };
    const { result, rerender } = renderHook(
      () => ({ roles: current.roles.useMyRoles(), label: current.auth.useAuthToken().data }),
      { wrapper },
    );
    await waitFor(() => expect(packets.some((packet) => packet.query.includes('myRoles'))).toBe(true));
    const labelA = labels()[0];
    await act(async () => {
      await changeAccount(current, 'owned-B');
    });
    rerender();
    await waitFor(() => expect(result.current.roles).toEqual([{ role: 'leader', boardType: 'tension' }]));
    const labelB = result.current.label;
    expect(labelB).not.toBe(labelA);
    release.resolve();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.roles).toEqual([{ role: 'leader', boardType: 'tension' }]);
    heldRoles = undefined;
    await act(async () => {
      await changeAccount(current, 'owned-A');
    });
    rerender();
    await waitFor(() => expect(result.current.roles).toEqual([{ role: 'leader', boardType: 'kilter' }]));
    expect(result.current.label).not.toBe(labelA);
    expect(() => current.clients.getHttpClient(labelA)).toThrow();
    expect(labels().every((label) => label.startsWith('bshv1_'))).toBe(true);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => [query.queryKey, query.state.data]),
      ),
    ).not.toContain('bsbd1_');
  });

  it('pins a privacy mutation before TanStack onMutate and refuses B before any mutation packet', async () => {
    const current = await start();
    const pause = deferred();
    const beforeMutation = vi.fn(() => pause.promise);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      mutationCache: new MutationCache({ onMutate: beforeMutation }),
    });
    const { result, rerender } = renderHook(
      () => ({ mutation: current.privacy.useUpdatePrivacySettings(), label: current.auth.useAuthToken().data }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.label).toMatch(/^bshv1_/));
    await waitFor(() => expect(result.current.mutation.isReady).toBe(true));
    let pending!: ReturnType<typeof result.current.mutation.mutateAsync>;
    act(() => {
      pending = result.current.mutation.mutateAsync({ isPrivate: true });
    });
    const rejected = expect(pending).rejects.toThrow('same signed-in account');
    await waitFor(() => expect(beforeMutation).toHaveBeenCalledTimes(1));
    await act(async () => {
      await changeAccount(current, 'owned-B');
    });
    rerender();
    pause.resolve();
    await rejected;
    expect(packets.filter((packet) => packet.query.includes('updatePrivacySettings'))).toEqual([]);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).not.toContain('bsbd1_');
  });

  it('a follow action without profile data still refuses its captured web view after B', async () => {
    const current = await start();
    state.profile = undefined;
    const pause = deferred();
    const beforeMutation = vi.fn(() => pause.promise);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      mutationCache: new MutationCache({ onMutate: beforeMutation }),
    });
    const { result, rerender } = renderHook(
      () => ({ mutation: current.privacy.usePrivacyFollowAction(), label: current.auth.useAuthToken().data }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.label).toMatch(/^bshv1_/));
    await waitFor(() => expect(result.current.mutation.isReady).toBe(true));
    let pending!: ReturnType<typeof result.current.mutation.mutateAsync>;
    act(() => {
      pending = result.current.mutation.mutateAsync({ action: 'approve', userId: 'requester' });
    });
    const rejected = expect(pending).rejects.toThrow('same signed-in account');
    await waitFor(() => expect(beforeMutation).toHaveBeenCalledTimes(1));
    await act(async () => {
      await changeAccount(current, 'owned-B');
    });
    state.profile = undefined;
    rerender();
    pause.resolve();
    await rejected;
    expect(packets).toEqual([]);
  });

  it('a cache-refresh await cannot publish A settings after B or invoke its success callback', async () => {
    const current = await start();
    const { result, rerender } = renderHook(
      () => ({ mutation: current.privacy.useUpdatePrivacySettings(), label: current.auth.useAuthToken().data }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.label).toMatch(/^bshv1_/));
    await waitFor(() => expect(result.current.mutation.isReady).toBe(true));
    const labelA = result.current.label!;
    const pause = deferred();
    const invalidation = vi.spyOn(queryClient, 'invalidateQueries').mockImplementationOnce(() => pause.promise);
    const success = vi.fn();
    let pending!: ReturnType<typeof result.current.mutation.mutateAsync>;
    act(() => {
      pending = result.current.mutation.mutateAsync({ isPrivate: true }, { onSuccess: success });
    });
    const rejected = expect(pending).rejects.toThrow();
    await waitFor(() => expect(invalidation).toHaveBeenCalledTimes(1));
    await act(async () => {
      await changeAccount(current, 'owned-B');
    });
    rerender();
    pause.resolve();
    await rejected;
    expect(success).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['privacySettings', 'owned-A', 'browser-view', labelA])).toBeUndefined();
    expect(packets.filter((packet) => packet.query.includes('updatePrivacySettings'))).toHaveLength(1);
  });

  it('checks the exact original delivered settings again after the component owns another await', async () => {
    const current = await start();
    const { result } = renderHook(
      () => ({ mutation: current.privacy.useUpdatePrivacySettings(), label: current.auth.useAuthToken().data }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.label).toMatch(/^bshv1_/));
    await waitFor(() => expect(result.current.mutation.isReady).toBe(true));
    let settings!: PrivacySettings;
    await act(async () => {
      settings = await result.current.mutation.mutateAsync({ isPrivate: true });
    });
    expect(() => result.current.mutation.assertCurrentResult(settings)).not.toThrow();
    const label = result.current.label!;
    clock = 90_000;
    await current.clients.getHttpClient(label).request('{ privacySettings { enabled } }');
    clock = 120_000;
    await Promise.resolve();
    expect(current.clients.browserHttpClients.isCurrentView(label)).toBe(true);
    expect(() => result.current.mutation.assertCurrentResult(settings)).toThrow();
  });

  it('an unseen selected503 cannot publish a legacy A label or dispatch the private roles query', async () => {
    const current = await start(true);
    state.required = true;
    state.account = 'owned-B';
    state.unavailable = true;
    const { result } = renderHook(() => ({ roles: current.roles.useMyRoles(), auth: current.auth.useAuthToken() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.auth.isError).toBe(true));
    expect(result.current.auth.data).toBeUndefined();
    expect(result.current.roles).toEqual([]);
    expect(packets).toEqual([]);
    expect(current.store.captureConfirmedWebAuthIdentity()?.userId).toBe('owned-A');
    expect(current.store.hasConfirmedAnonymousWebSession()).toBe(false);
  });
});
