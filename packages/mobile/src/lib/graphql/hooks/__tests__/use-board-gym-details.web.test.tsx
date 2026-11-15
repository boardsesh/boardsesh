// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_GYM, type GetGymQueryResponse } from '@boardsesh/graphql/operations/gyms';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
const state = vi.hoisted(() => ({
  required: true,
  legacy: false,
  anonymous: false,
  unavailable: false,
  account: 'owned-A',
  sid: 'login-A',
  version: 2,
  generation: 1,
}));
vi.mock('../../client', () => ({
  getHttpClient: (...arguments_: [scope?: string | null]) => active().clients.getHttpClient(...arguments_),
}));
vi.mock('../../request-scope', () => ({
  isCurrentHttpView: (scope: string | undefined) => active().scope.isCurrentHttpView(scope),
  httpScopeQueryKey: (key: readonly unknown[], scope: string | undefined) =>
    active().scope.httpScopeQueryKey(key, scope),
}));
vi.mock('../../use-auth-token', () => ({ useAuthToken: () => active().auth.useAuthToken() }));
vi.mock('../../use-http-operation-scope', () => ({
  useHttpOperationScope: () => active().operationScope.useHttpOperationScope(),
  isHttpCacheScoped: () => active().operationScope.isHttpCacheScoped(),
}));
vi.mock('../../http-operation', () => ({
  createHttpOperation: (...parameters: Parameters<typeof import('../../http-operation.web').createHttpOperation>) =>
    active().operations.createHttpOperation(...parameters),
}));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => active().store.captureAuthCredentialGeneration(),
  isAuthCredentialGenerationCurrent: (generation: number) =>
    active().store.isAuthCredentialGenerationCurrent(generation),
}));
vi.mock('../../../browser-consumer-readiness.web', () => ({ publicExpoBrowserConsumersReady: () => state.required }));
vi.mock('../../../browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: vi.fn(async () => {}) }));
vi.mock('../../../auth-interceptor', () => ({
  authenticatedFetch: (input: string | URL | Request, init?: RequestInit) =>
    active().interceptor.authenticatedFetch(input, init),
}));
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
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'owned-finite5' } } }));
// Physical native widgets are replaced; the actual editor, its once-only form
// state, adopted hook, query scope, SDK and browser admission remain installed.
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useLocalSearchParams: () => ({ gymUuid: target }),
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../index', () => ({
  useGym: (gymUuid: string | null) => active().hooks.useGym(gymUuid),
  useUpdateGym: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', label: '#000', secondaryLabel: '#666' } }),
}));
vi.mock('../../../../hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../../hooks/use-header-actions', () => ({ useHeaderActions: vi.fn() }));
vi.mock('../../../../hooks/use-typography-styles', () => ({ useTypographyStyles: () => ({}) }));
vi.mock('../../../haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../components/Button', () => ({ Button: () => null }));
vi.mock('../../../../components/ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div') }));
vi.mock('../../../../components/AccessibleTextInput', () => ({
  AccessibleTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    accessibilityLabel: string;
  }) =>
    createElement('input', {
      value,
      'aria-label': accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
vi.mock('../../../../components/SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../../../../components/gym-directory/GymWriteAccessSection', () => ({ GymWriteAccessSection: () => null }));
vi.mock('../../../../components/gym-directory/ClaimGymSheet', () => ({ ClaimGymSheet: () => null }));
type Runtime = {
  store: typeof import('../../../auth-store.web');
  clients: typeof import('../../client.web');
  backend: typeof import('../../../browser-backend-client.web');
  auth: typeof import('../../use-auth-token.web');
  scope: typeof import('../../request-scope.web');
  operationScope: typeof import('../../use-http-operation-scope.web');
  operations: typeof import('../../http-operation.web');
  interceptor: typeof import('../../../auth-interceptor.web');
  hooks: typeof import('../use-board-gym-details');
  queryScope: typeof import('../../use-http-query-scope');
};
let runtime: Runtime | undefined;
const kinds = ['board', 'gym', 'myGyms', 'slug', 'popular'] as const;
type Kind = (typeof kinds)[number];
const target = 'resource-owned-by-a-different-person';
const input = { boardType: 'tension' as const, limit: 12, offset: 7 };
let cache: QueryClient;
let clock: number;
let packetSequence: number;
let packets: {
  query: string;
  variables: unknown;
  authorization: string | null;
  owner: BrowserBackendLeaseOwner | null;
}[];
let issued: Map<string, BrowserBackendLeaseOwner>;
let leaseCalls: number;
let held: { kind: Kind; promise: Promise<void>; resolve: () => void } | undefined;
let failGraphql: boolean;
let releases: (() => void)[];
function active(): Runtime {
  if (!runtime) throw new Error('Owned actual runtime not initialized');
  return runtime;
}
function owner(): BrowserBackendLeaseOwner {
  return {
    userId: state.account,
    authSessionId: state.sid,
    generation: state.generation,
    cursor: { bindingId: 'a'.repeat(64), version: state.version },
  };
}
function logicalKey(kind: Kind, enabled = true) {
  switch (kind) {
    case 'board':
      return ['board', enabled ? target : null];
    case 'gym':
      return ['gym', enabled ? target : null];
    case 'myGyms':
      return ['myGyms'];
    case 'slug':
      return ['boardBySlug', target];
    case 'popular':
      return ['popularBoardConfigs', input];
  }
}
function useRead(kind: Kind, enabled = true) {
  const hooks = active().hooks;
  switch (kind) {
    case 'board':
      return hooks.useBoard(enabled ? target : null);
    case 'gym':
      return hooks.useGym(enabled ? target : null);
    case 'myGyms':
      return hooks.useMyGyms({ enabled });
    case 'slug':
      return hooks.useBoardBySlug(target, { enabled });
    case 'popular':
      return hooks.usePopularBoardConfigs(input, { enabled });
  }
}
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: cache }, children);
}
function field(kind: Kind) {
  return kind === 'slug' ? 'boardBySlug' : kind === 'popular' ? 'popularBoardConfigs' : kind;
}
function answer(current: BrowserBackendLeaseOwner | null) {
  const answerId = current
    ? `${current.userId}:${current.authSessionId}:${current.generation}:${current.cursor.version}`
    : 'anonymous';
  const entity = {
    uuid: target,
    slug: target,
    ownerId: 'different-person',
    canEdit: current !== null,
    name: answerId,
    location: current?.userId === 'owned-A' ? 'A-private-address' : null,
    address: current?.userId === 'owned-A' ? 'A-private-address' : null,
    contactEmail: current?.userId === 'owned-A' ? 'A-private-email' : null,
    latitude: current?.userId === 'owned-A' ? 10 : null,
  };
  return {
    board: entity,
    gym: entity,
    boardBySlug: entity,
    myGyms: { gyms: [entity], totalCount: 80, hasMore: true },
    popularBoardConfigs: { configs: [{ boardType: 'tension' }], totalCount: 50, hasMore: true },
    viewer: { id: current?.userId ?? null },
  };
}
function hold(kind: Kind) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  held = { kind, promise, resolve: release };
  return held;
}
beforeEach(() => {
  vi.resetModules();
  Object.assign(state, {
    required: true,
    legacy: false,
    anonymous: false,
    unavailable: false,
    account: 'owned-A',
    sid: 'login-A',
    version: 2,
    generation: 1,
  });
  runtime = undefined;
  clock = 0;
  packetSequence = 0;
  leaseCalls = 0;
  packets = [];
  issued = new Map();
  held = undefined;
  releases = [];
  failGraphql = false;
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/auth/session')) {
        if (state.unavailable) return Response.json({ error: 'unavailable' }, { status: 503 });
        if (state.anonymous) return Response.json({});
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
            authSessionId: state.sid,
          });
        leaseCalls++;
        const token = `bsbd1_OWNED_FINITE_${++packetSequence}`;
        issued.set(token, owner());
        return Response.json({ status: 'admitted', token, usableForMs: 120000, owner: owner() });
      }
      if (!url.endsWith('/graphql')) throw new Error('Unexpected owned URL');
      if (typeof options?.body !== 'string') throw new Error('Expected installed SDK JSON body');
      const payload = JSON.parse(options.body) as { query: string; variables: unknown };
      const authorization = new Headers(options.headers).get('Authorization');
      const current = state.legacy ? owner() : (issued.get(authorization?.slice('Bearer '.length) ?? '') ?? null);
      packets.push({ ...payload, authorization, owner: current });
      const selectedKind: Kind = payload.query.includes('boardBySlug(')
        ? 'slug'
        : payload.query.includes('myGyms(')
          ? 'myGyms'
          : payload.query.includes('popularBoardConfigs(')
            ? 'popular'
            : payload.query.includes('gym(')
              ? 'gym'
              : 'board';
      if (failGraphql || (selectedKind === 'myGyms' && !current))
        return Response.json({ errors: [{ message: 'Owned GraphQL refusal' }] }, { status: 403 });
      const contents = JSON.stringify({ data: answer(current) });
      const blocked = held;
      if (blocked && blocked.kind === selectedKind) {
        held = undefined;
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(contents));
              await blocked.promise;
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return Response.json({ data: answer(current) });
    }),
  );
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
});
afterEach(() => {
  for (const release of releases) release();
  cleanup();
  cache.clear();
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function start(mode: 'selected' | 'anonymous' | 'unavailable' | 'legacy' = 'selected'): Promise<Runtime> {
  state.legacy = mode === 'legacy';
  state.required = !state.legacy;
  state.anonymous = mode === 'anonymous';
  state.unavailable = mode === 'unavailable';
  const store = await import('../../../auth-store.web');
  const admission = await store.synchronizeWebSession();
  expect(admission.status).toBe(
    mode === 'anonymous' ? 'anonymous' : mode === 'unavailable' ? 'unavailable' : 'authenticated',
  );
  const clients = await import('../../client.web');
  const backend = await import('../../../browser-backend-client.web');
  const auth = await import('../../use-auth-token.web');
  const scope = await import('../../request-scope.web');
  const operationScope = await import('../../use-http-operation-scope.web');
  const operations = await import('../../http-operation.web');
  const interceptor = await import('../../../auth-interceptor.web');
  const hooks = await import('../use-board-gym-details');
  const queryScope = await import('../../use-http-query-scope');
  return (runtime = {
    store,
    clients,
    backend,
    auth,
    scope,
    operationScope,
    operations,
    interceptor,
    hooks,
    queryScope,
  });
}
async function replace(change: 'B' | 'ABA' | 'SID' | 'version' | 'generation') {
  const current = active();
  if (change === 'B' || change === 'ABA') {
    state.account = 'owned-B';
    state.sid = 'login-B';
    await current.store.synchronizeWebSession();
    if (change === 'ABA') {
      state.account = 'owned-A';
      state.sid = 'login-A';
      await current.store.synchronizeWebSession();
    }
  } else {
    if (change === 'SID') state.sid = 'login-A-2';
    if (change === 'version') state.version++;
    if (change === 'generation') state.generation++;
    await current.store.synchronizeWebSession();
  }
}
describe('actual finite5 browser hooks, installed SDK, manager, labels and cache', () => {
  it.each(kinds)('publishes %s under only its actual namespace with one packet', async (kind) => {
    const current = await start();
    const { result } = renderHook(() => ({ read: useRead(kind), scope: current.queryScope.useHttpQueryScope() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
    expect(cache.getQueryData(result.current.scope.key(logicalKey(kind)))).toEqual(answer(owner()));
    expect(cache.getQueryData(logicalKey(kind))).toBeUndefined();
    expect(result.current.read.data).toEqual(answer(owner())[field(kind)]);
    expect(packets[0].variables).toEqual(
      kind === 'board'
        ? { boardUuid: target }
        : kind === 'gym'
          ? { gymUuid: target }
          : kind === 'slug'
            ? { slug: target }
            : kind === 'myGyms'
              ? { input: { limit: 50 } }
              : { input },
    );
    expect(packets[0].owner?.userId).toBe('owned-A');
    expect(
      JSON.stringify(
        cache
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ),
    ).not.toContain('bsbd1_');
  });
  it.each(kinds)('keeps cached A %s out of another view of the same target', async (kind) => {
    await start();
    const { result, rerender } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const before = packets.length;
    await act(async () => {
      await replace('B');
    });
    rerender();
    await waitFor(() => expect(result.current.data).toEqual(answer(owner())[field(kind)]));
    expect(packets.length).toBeGreaterThan(before);
    expect(JSON.stringify(result.current.data)).not.toContain('A-private-address');
  });
  it.each(['B', 'ABA', 'SID', 'version', 'generation'] as const)(
    'refuses a held original SDK body after %s replacement',
    async (change) => {
      await start();
      const blocked = hold('board');
      const { result, rerender } = renderHook(() => useRead('board'), { wrapper });
      await waitFor(() => expect(packets).toHaveLength(1));
      await act(async () => {
        await replace(change);
      });
      rerender();
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const fresh = result.current.data;
      blocked.resolve();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(result.current.data).toEqual(fresh);
      expect(result.current.isSuccess).toBe(true);
    },
  );
  it('refuses original expiry even after an independently live fresh same-owner lease', async () => {
    const current = await start();
    const blocked = hold('board');
    const { result } = renderHook(() => useRead('board'), { wrapper });
    await waitFor(() => expect(packets).toHaveLength(1));
    clock = 120001;
    await current.clients.getHttpClient().request('{ viewer { id } }');
    expect(leaseCalls).toBe(2);
    blocked.resolve();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
  it.each(['board', 'gym', 'slug', 'popular'] as const)(
    'supports confirmed anonymous %s with zero selected leases',
    async (kind) => {
      await start('anonymous');
      const { result } = renderHook(() => useRead(kind), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(leaseCalls).toBe(0);
      expect(packets).toHaveLength(1);
      expect(packets[0].authorization).toBeNull();
      expect(result.current.data).toEqual(answer(null)[field(kind)]);
    },
  );
  it('retains authenticated MyGyms denial instead of synthetic empty success', async () => {
    await start('anonymous');
    const { result } = renderHook(() => useRead('myGyms'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(leaseCalls).toBe(0);
  });
  it.each(kinds)('keeps unavailable required %s inert without raw cache adoption', async (kind) => {
    await start('unavailable');
    cache.setQueryData(logicalKey(kind), answer(owner()));
    const { result } = renderHook(() => useRead(kind), { wrapper });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(packets).toEqual([]);
    expect(leaseCalls).toBe(0);
    expect(result.current.data).toBeUndefined();
  });
  it.each(kinds)('preserves wholly legacy %s keys, selected shape and one packet', async (kind) => {
    await start('legacy');
    const { result } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cache.getQueryData(logicalKey(kind))).toEqual(answer(owner()));
    expect(result.current.data).toEqual(answer(owner())[field(kind)]);
    expect(packets).toHaveLength(1);
    expect(leaseCalls).toBe(0);
  });
  it('retains the one-hour selected catalog cache on remount without another packet', async () => {
    await start();
    const first = renderHook(() => useRead('popular'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    const second = renderHook(() => useRead('popular'), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(packets).toHaveLength(1);
  });
  it('disabled/new-owner queries neither send nor adopt the prior owner cache', async () => {
    await start();
    const { result, rerender } = renderHook(({ enabled }) => useRead('popular', enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await replace('B');
    });
    rerender({ enabled: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toBeUndefined();
    expect(packets).toHaveLength(1);
  });
  it('scoped invalidation touches only its own namespace and does not pretend raw writers were adopted', async () => {
    const current = await start();
    const { result, rerender } = renderHook(
      () => ({ read: useRead('popular'), scope: current.queryScope.useHttpQueryScope() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
    const scopeA = result.current.scope;
    const keyA = scopeA.key(logicalKey('popular'));
    await act(async () => {
      await replace('B');
    });
    rerender();
    await waitFor(() => expect(packets).toHaveLength(2));
    const keyB = result.current.scope.key(logicalKey('popular'));
    await act(async () => {
      await cache.invalidateQueries({ queryKey: ['popularBoardConfigs'] });
    });
    expect(packets).toHaveLength(2);
    await expect(scopeA.cache(cache).invalidateQueries({ queryKey: ['popularBoardConfigs'] })).rejects.toThrow();
    await act(async () => {
      await result.current.scope.cache(cache).invalidateQueries({ queryKey: ['popularBoardConfigs'] });
    });
    expect(packets).toHaveLength(3);
    expect(cache.getQueryData(keyA)).toEqual(answer({ ...owner(), userId: 'owned-A', authSessionId: 'login-A' }));
    expect(cache.getQueryData(keyB)).toEqual(answer(owner()));
  });
  it.each(['network', 'warm-cache'] as const)(
    'the actual same-gym editor clears private form seeds on %s view replacement',
    async (mode) => {
      const current = await start();
      const { default: EditGym } = await import('../../../../../app/gyms/edit');
      const view = render(createElement(EditGym), { wrapper });
      await waitFor(() =>
        expect((screen.getByLabelText('mobile.gymEdit.address') as HTMLInputElement).value).toBe('A-private-address'),
      );
      expect((screen.getByLabelText('mobile.gymEdit.contactEmail') as HTMLInputElement).value).toBe('A-private-email');
      await act(async () => {
        await replace('B');
        if (mode === 'warm-cache') {
          const label = current.clients.browserHttpClients.captureHandle();
          const operation = current.operations.createHttpOperation(label);
          const decoded = await operation.request<GetGymQueryResponse>(GET_GYM, { gymUuid: target });
          operation.assertDeliveries();
          const physicalKey = [...current.scope.httpScopeQueryKey([], label), ...logicalKey('gym')];
          cache.setQueryData(physicalKey, decoded);
          expect(cache.getQueryData(physicalKey)).toEqual(answer(owner()));
        }
      });
      view.rerender(createElement(EditGym));
      await waitFor(() => expect(packets.length).toBeGreaterThanOrEqual(2));
      await waitFor(() =>
        expect((screen.getByLabelText('mobile.gymEdit.name') as HTMLInputElement).value).toBe('owned-B:login-B:1:2'),
      );
      expect((screen.getByLabelText('mobile.gymEdit.address') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('mobile.gymEdit.contactEmail') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('mobile.gymEdit.latitude') as HTMLInputElement).value).toBe('');
      expect(packets[0].owner?.userId).toBe('owned-A');
      expect(packets.slice(1).every((packet) => packet.owner?.userId === 'owned-B')).toBe(true);
    },
  );
});
