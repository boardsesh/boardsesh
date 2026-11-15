// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSession } from '@boardsesh/shared-schema';
import {
  GET_SESSION,
  GET_SESSION_OWNER,
  type GetSessionQueryResponse,
  type GetSessionOwnerQueryResponse,
} from '../../operations';
import { BOARD_LIVE_SESSIONS, type BoardLiveSessionsResponse } from '@boardsesh/graphql/operations/live-sessions';
import { toLiveCardModel } from '../../../../components/live-sessions/live-session-model';
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
  focused: true,
  offline: false,
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
vi.mock('expo-router', () => ({
  useIsFocused: () => state.focused,
  router: { push: vi.fn(), navigate: vi.fn() },
}));
vi.mock('../../../../hooks/use-is-offline', () => ({ useIsOffline: () => state.offline }));
// Actual consumer logic stays installed; native widgets and unrelated device
// effects are fixtures. No held always-true navigation callback is supplied.
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../index', () => ({
  useSessionOwnerUserId: (id: string | undefined) => active().detail.useSessionOwnerUserId(id),
  useProfile: () => active().profile.useProfile(),
}));
vi.mock('../../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: null }),
  useQueueSessionControls: () => ({
    sessionId: target,
    participantId: active().store.captureConfirmedWebAuthIdentity()?.userId ?? null,
  }),
  useQueueLiveStats: () => {
    const identity = active().store.captureConfirmedWebAuthIdentity();
    return { sessionUsers: identity ? [{ id: identity.userId, userId: identity.userId }] : [] };
  },
}));
vi.mock('../../../session-store', () => ({ getStoredCreatedSessionId: async () => null }));
vi.mock('../../../analytics', () => ({ track: vi.fn() }));
vi.mock('../../../haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../app-visibility', () => ({ useIsAppBackgrounded: () => false }));
vi.mock('../../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false, isOffline: state.offline, reason: null }),
}));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../components/you/AvatarGroup', () => ({ AvatarGroup: () => null }));
vi.mock('../../../../components/PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12, full: 999 },
}));
vi.mock('../../../../components/live-sessions/LiveDot', () => ({ useLivePulseDriver: vi.fn() }));
vi.mock('../../../../components/live-sessions/use-elapsed-clock', () => ({
  useElapsedClock: () => 42 * 60_000,
  startedAtKeyFor: () => '',
}));
vi.mock('../../../../components/live-sessions/LiveBadges', () => ({
  LiveActionPill: ({ label }: { label: string }) => createElement('span', null, label),
  LiveGradeChip: ({ label }: { label: string }) => createElement('span', null, label),
  LiveStatusDot: () => null,
}));
vi.mock('../../../../components/live-sessions/use-live-session-colors', () => ({ useLiveSessionColors: () => ({}) }));
type Runtime = {
  store: typeof import('../../../auth-store.web');
  clients: typeof import('../../client.web');
  backend: typeof import('../../../browser-backend-client.web');
  auth: typeof import('../../use-auth-token.web');
  scope: typeof import('../../request-scope.web');
  operationScope: typeof import('../../use-http-operation-scope.web');
  operations: typeof import('../../http-operation.web');
  interceptor: typeof import('../../../auth-interceptor.web');
  detail: typeof import('../use-session-detail');
  live: typeof import('../use-live-sessions');
  profile: typeof import('../use-profile');
  queryScope: typeof import('../../use-http-query-scope');
};
let runtime: Runtime | undefined;
const kinds = ['detail', 'preview', 'owner', 'followed', 'board'] as const;
type Kind = (typeof kinds)[number];
const target = 'session-owned-by-C';
const boardId = 42;
const boardUuid = 'board-owned-by-C';
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
let releases: (() => void)[];
let failGraphql: boolean;
let missing: boolean;
function active(): Runtime {
  if (!runtime) throw new Error('Actual runtime not initialized');
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
function marker(current: BrowserBackendLeaseOwner | null) {
  return current
    ? `${current.userId}:${current.authSessionId}:${current.generation}:${current.cursor.version}`
    : 'anonymous';
}
function logicalKey(kind: Kind, enabled = true) {
  switch (kind) {
    case 'detail':
      return ['sessionDetail', enabled ? target : undefined];
    case 'preview':
      return ['sessionPreview', enabled ? target : undefined];
    case 'owner':
      return ['sessionOwner', enabled ? target : undefined];
    case 'followed':
      return ['liveSessions', 'followed', boardUuid];
    case 'board':
      return ['liveSessions', 'board', enabled ? boardId : null, boardUuid];
  }
}
function useRead(kind: Kind, enabled = true) {
  const current = active();
  switch (kind) {
    case 'detail':
      return current.detail.useSessionDetail(enabled ? target : undefined);
    case 'preview':
      return current.detail.useSessionPreview(enabled ? target : undefined);
    case 'owner':
      return current.detail.useSessionOwnerUserId(enabled ? target : undefined);
    case 'followed':
      return current.live.useFollowedLiveSessions(boardUuid, enabled);
    case 'board':
      return current.live.useBoardLiveSessions(enabled ? boardId : null, enabled, boardUuid);
  }
}
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: cache }, children);
}
function liveRow(current: BrowserBackendLeaseOwner | null): LiveSession {
  const privateView = current?.userId === 'owned-A';
  return {
    sessionId: target,
    name: marker(current),
    goal: null,
    color: null,
    startedAt: '2026-09-16T10:00:00.000Z',
    lastActivity: '2026-09-16T10:30:00.000Z',
    host: {
      userId: 'resource-owner-C',
      displayName: privateView ? 'A-private-person' : 'B-visible-person',
      avatarUrl: null,
    },
    participants: privateView
      ? [
          { userId: 'owned-A', displayName: 'Viewer A', avatarUrl: null },
          { userId: 'resource-owner-C', displayName: 'A-private-person', avatarUrl: null },
        ]
      : [{ userId: 'public-person', displayName: 'B-visible-person', avatarUrl: null }],
    participantCount: privateView ? 2 : 1,
    followedParticipantIds: privateView ? ['resource-owner-C'] : [],
    viewerIsMember: privateView,
    isPublic: true,
    board: { uuid: boardUuid, name: marker(current), slug: null, boardType: 'kilter', gymName: null },
    boardType: 'kilter',
    angle: 40,
    sendCount: 3,
    flashCount: 1,
    hardestSendGrade: 'V5',
    currentClimb: { name: marker(current), grade: 'V5' },
    reasons: privateView ? ['FOLLOWING_USER'] : ['SELECTED_BOARD'],
  };
}
function response(kind: Kind, current: BrowserBackendLeaseOwner | null) {
  const privateView = current?.userId === 'owned-A';
  const session = missing
    ? null
    : {
        id: target,
        name: marker(current),
        boardPath: '/b/board-C',
        users: [],
        createdByUserId: privateView ? 'resource-owner-C' : null,
      };
  if (kind === 'detail')
    return {
      sessionDetail: missing
        ? null
        : {
            sessionId: target,
            sessionType: 'party',
            ownerUserId: privateView ? 'resource-owner-C' : null,
            sessionName: marker(current),
            notes: privateView ? 'A-private-notes' : null,
            participants: privateView ? [{ userId: 'resource-owner-C' }] : [],
            ticks: privateView ? [{ uuid: 'A-private-tick', userId: 'resource-owner-C' }] : [],
            healthKitWorkoutId: privateView ? 'A-private-health-link' : null,
          },
    };
  if (kind === 'preview' || kind === 'owner') return { session };
  return kind === 'followed'
    ? { followedLiveSessions: missing ? [] : [liveRow(current)] }
    : { boardLiveSessions: missing ? [] : [liveRow(current)] };
}
function selected(kind: Kind, current: BrowserBackendLeaseOwner | null): unknown {
  const payload = response(kind, current);
  if ('sessionDetail' in payload) return payload.sessionDetail;
  if ('session' in payload) return kind === 'owner' ? (payload.session?.createdByUserId ?? null) : payload.session;
  const rows = 'followedLiveSessions' in payload ? payload.followedLiveSessions : payload.boardLiveSessions;
  if (!rows) throw new Error('Owned fixture missing live rows');
  return rows.map(toLiveCardModel);
}
function stored(kind: Kind, current: BrowserBackendLeaseOwner | null) {
  return kind === 'followed' || kind === 'board' ? response(kind, current) : selected(kind, current);
}
function variables(kind: Kind) {
  return kind === 'followed'
    ? { boardUuid, limit: 12 }
    : kind === 'board'
      ? { boardId, boardUuid }
      : { sessionId: target };
}
function identify(query: string): Kind | 'viewer' | 'profile' {
  if (query.includes('sessionDetail(')) return 'detail';
  if (query.includes('followedLiveSessions(')) return 'followed';
  if (query.includes('boardLiveSessions(')) return 'board';
  if (query.includes('createdByUserId')) return 'owner';
  if (query.includes('session(')) return 'preview';
  return query.includes('profile') ? 'profile' : 'viewer';
}
function hold(kind: Kind) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return (held = { kind, promise, resolve });
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
    focused: true,
    offline: false,
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
  missing = false;
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
        const token = `bsbd1_OWNED_SESSION_${++packetSequence}`;
        issued.set(token, owner());
        return Response.json({ status: 'admitted', token, usableForMs: 120000, owner: owner() });
      }
      if (!url.endsWith('/graphql') || typeof options?.body !== 'string')
        throw new Error('Expected owned actual SDK request');
      const payload = JSON.parse(options.body) as { query: string; variables: unknown };
      const authorization = new Headers(options.headers).get('Authorization');
      const current = state.legacy ? owner() : (issued.get(authorization?.slice('Bearer '.length) ?? '') ?? null);
      packets.push({ ...payload, authorization, owner: current });
      const kind = identify(payload.query);
      const refused = failGraphql || (kind === 'followed' && !current);
      const payloadData =
        kind === 'viewer'
          ? { viewer: { id: current?.userId ?? null } }
          : kind === 'profile'
            ? { profile: current ? { id: current.userId, displayName: current.userId, avatarUrl: null } : null }
            : response(kind, current);
      const blocked = held;
      if (blocked && blocked.kind === kind) {
        held = undefined;
        // A distinct original payload makes ABA refusal observable too.
        const contents = JSON.stringify(
          refused
            ? { errors: [{ message: 'Owned GraphQL refusal' }] }
            : { data: { ...payloadData, retiredOriginal: true } },
        );
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(contents));
              await blocked.promise;
              controller.close();
            },
          }),
          { status: refused ? 403 : 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (refused) return Response.json({ errors: [{ message: 'Owned GraphQL refusal' }] }, { status: 403 });
      return Response.json({ data: payloadData });
    }),
  );
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity }, mutations: { retry: false } },
  });
});
afterEach(() => {
  for (const resolve of releases) resolve();
  cleanup();
  cache.clear();
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  vi.useRealTimers();
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
  const clients = await import('../../client.web'),
    backend = await import('../../../browser-backend-client.web'),
    auth = await import('../../use-auth-token.web'),
    scope = await import('../../request-scope.web'),
    operationScope = await import('../../use-http-operation-scope.web'),
    operations = await import('../../http-operation.web'),
    interceptor = await import('../../../auth-interceptor.web'),
    detail = await import('../use-session-detail'),
    live = await import('../use-live-sessions'),
    profile = await import('../use-profile'),
    queryScope = await import('../../use-http-query-scope');
  return (runtime = {
    store,
    clients,
    backend,
    auth,
    scope,
    operationScope,
    operations,
    interceptor,
    detail,
    live,
    profile,
    queryScope,
  });
}
async function warmCurrent(kind: 'owner' | 'preview' | 'board') {
  const current = active();
  const label = current.clients.browserHttpClients.captureHandle();
  const operation = current.operations.createHttpOperation(label);
  let decoded: unknown;
  if (kind === 'owner') {
    const raw = await operation.request<GetSessionOwnerQueryResponse>(GET_SESSION_OWNER, { sessionId: target });
    decoded = raw.session?.createdByUserId ?? null;
  } else if (kind === 'preview') {
    const raw = await operation.request<GetSessionQueryResponse>(GET_SESSION, { sessionId: target });
    decoded = raw.session;
  } else {
    decoded = await operation.request<BoardLiveSessionsResponse>(BOARD_LIVE_SESSIONS, { boardId, boardUuid });
  }
  operation.assertDeliveries();
  const physicalKey = [...current.scope.httpScopeQueryKey([], label), ...logicalKey(kind)];
  cache.setQueryData(physicalKey, decoded);
  expect(cache.getQueryData(physicalKey)).toEqual(stored(kind, owner()));
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
describe('actual five session browser hooks, SDK decoder, manager, labels and cache', () => {
  it.each(kinds)('publishes %s exact projection/cache and one packet in its actual namespace', async (kind) => {
    const current = await start();
    const { result } = renderHook(() => ({ read: useRead(kind), scope: current.queryScope.useHttpQueryScope() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
    expect(result.current.read.data).toEqual(selected(kind, owner()));
    expect(cache.getQueryData(result.current.scope.key(logicalKey(kind)))).toEqual(stored(kind, owner()));
    expect(cache.getQueryData(logicalKey(kind))).toBeUndefined();
    expect(packets).toHaveLength(1);
    expect(packets[0].variables).toEqual(variables(kind));
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
  it.each(kinds)('never adopts cached A %s for B viewing the same target', async (kind) => {
    await start();
    const { result, rerender } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await replace('B');
    });
    rerender();
    await waitFor(() => expect(packets).toHaveLength(2));
    await waitFor(() => expect(result.current.data).toEqual(selected(kind, owner())));
    expect(JSON.stringify(result.current.data)).not.toContain('A-private');
    if (kind === 'owner') expect(result.current.data).toBeNull();
  });
  it.each(['B', 'ABA', 'SID', 'version', 'generation'] as const)(
    'rejects original held SDK detail after %s replacement',
    async (change) => {
      const current = await start();
      const blocked = hold('detail');
      const { result, rerender } = renderHook(
        () => ({ read: useRead('detail'), scope: current.queryScope.useHttpQueryScope() }),
        { wrapper },
      );
      await waitFor(() => expect(packets).toHaveLength(1));
      const originalKey = result.current.scope.key(logicalKey('detail'));
      await act(async () => {
        await replace(change);
      });
      rerender();
      await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
      const fresh = result.current.read.data;
      blocked.resolve();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(result.current.read.data).toEqual(fresh);
      expect(cache.getQueryData(originalKey)).toBeUndefined();
    },
  );
  it('refuses the original response expiry while a fresh same-owner lease is independently live', async () => {
    const current = await start();
    const blocked = hold('detail');
    const { result } = renderHook(() => useRead('detail'), { wrapper });
    await waitFor(() => expect(packets).toHaveLength(1));
    clock = 120001;
    await current.clients.getHttpClient().request('{ viewer { id } }');
    expect(leaseCalls).toBe(2);
    blocked.resolve();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
  it.each(['detail', 'preview', 'owner', 'board'] as const)(
    'keeps confirmed-anonymous %s optional with zero selected leases',
    async (kind) => {
      await start('anonymous');
      const { result } = renderHook(() => useRead(kind), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(selected(kind, null));
      expect(leaseCalls).toBe(0);
      expect(packets).toHaveLength(1);
      expect(packets[0].authorization).toBeNull();
    },
  );
  it('keeps followed-session anonymous denial as a real error', async () => {
    await start('anonymous');
    const { result } = renderHook(() => useRead('followed'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(leaseCalls).toBe(0);
  });
  it.each(kinds)('required-unavailable %s stays inert despite poisoned raw cache', async (kind) => {
    await start('unavailable');
    cache.setQueryData(logicalKey(kind), stored(kind, owner()));
    const { result } = renderHook(() => useRead(kind), { wrapper });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(result.current.data).toBeUndefined();
    expect(packets).toEqual([]);
    expect(leaseCalls).toBe(0);
  });
  it.each(kinds)('preserves wholly legacy %s exact logical/cache/result contract', async (kind) => {
    await start('legacy');
    const { result } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(selected(kind, owner()));
    expect(cache.getQueryData(logicalKey(kind))).toEqual(stored(kind, owner()));
    expect(packets).toHaveLength(1);
    expect(packets[0].variables).toEqual(variables(kind));
    expect(leaseCalls).toBe(0);
  });
  it.each(kinds)('disabled new-view %s never sends or adopts A cache', async (kind) => {
    await start();
    const { result, rerender } = renderHook(({ enabled }) => useRead(kind, enabled), {
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
  it.each(['detail', 'preview', 'owner'] as const)(
    'retains actual %s null as a successful projected cache value',
    async (kind) => {
      const current = await start();
      missing = true;
      const { result } = renderHook(() => ({ read: useRead(kind), scope: current.queryScope.useHttpQueryScope() }), {
        wrapper,
      });
      await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
      expect(result.current.read.data).toBeNull();
      expect(cache.getQueryData(result.current.scope.key(logicalKey(kind)))).toBeNull();
    },
  );
  it('shows a current SDK failure without turning it into a null success', async () => {
    await start();
    failGraphql = true;
    const { result } = renderHook(() => useRead('preview'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(packets).toHaveLength(1);
  });
  it('keeps a same-view Infinity owner cache warm without a second packet', async () => {
    await start();
    const first = renderHook(() => useRead('owner'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    const second = renderHook(() => useRead('owner'), { wrapper });
    expect(second.result.current.data).toBe('resource-owner-C');
    await act(async () => {
      await Promise.resolve();
    });
    expect(packets).toHaveLength(1);
  });
  it('preserves boardId0 and exact optional UUID contexts as separate actual SDK/cache requests', async () => {
    const current = await start();
    const { result } = renderHook(
      () => ({
        noLink: current.live.useBoardLiveSessions(0, true),
        linked: current.live.useBoardLiveSessions(0, true, boardUuid),
        scope: current.queryScope.useHttpQueryScope(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.noLink.isSuccess && result.current.linked.isSuccess).toBe(true));
    expect(packets.map((packet) => packet.variables)).toEqual([{ boardId: 0 }, { boardId: 0, boardUuid }]);
    expect(cache.getQueryData(result.current.scope.key(['liveSessions', 'board', 0]))).toBeDefined();
    expect(cache.getQueryData(result.current.scope.key(['liveSessions', 'board', 0, boardUuid]))).toBeDefined();
  });
  it('an actual scoped refetch requests once and the staged raw invalidation does not reach a selected owner key', async () => {
    const current = await start();
    const { result } = renderHook(() => ({ read: useRead('owner'), scope: current.queryScope.useHttpQueryScope() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
    await act(async () => {
      await cache.invalidateQueries({ queryKey: ['sessionOwner', target] });
    });
    expect(packets).toHaveLength(1);
    await act(async () => {
      await result.current.read.refetch();
    });
    expect(packets).toHaveLength(2);
    const old = result.current.scope;
    await act(async () => {
      await replace('B');
    });
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
    await expect(old.cache(cache).invalidateQueries({ queryKey: ['sessionOwner', target] })).rejects.toThrow();
    expect(packets).toHaveLength(3);
  });
  it.each(['network', 'warm-cache'] as const)(
    'actual creator/preview consumer preserves unknown policy on %s replacement with confirmed roster identity',
    async (mode) => {
      const current = await start();
      const { useSessionExitOptions } = await import('../../../../components/session-screen/use-session-exit-options');
      const { result, rerender } = renderHook(
        () => ({ exit: useSessionExitOptions(), preview: current.detail.useSessionPreview(target) }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.preview.isSuccess).toBe(true));
      await waitFor(() => expect(result.current.exit.canEnd).toBe(false));
      expect(current.store.captureConfirmedWebAuthIdentity()?.userId).toBe('owned-A');
      await act(async () => {
        await replace('B');
        if (mode === 'warm-cache') {
          await warmCurrent('owner');
          await warmCurrent('preview');
        }
      });
      rerender();
      await waitFor(() => expect(result.current.preview.data?.name).toBe(marker(owner())));
      expect(current.store.captureConfirmedWebAuthIdentity()?.userId).toBe('owned-B');
      expect(result.current.exit.canEnd).toBe(true);
    },
  );
  it.each(['network', 'warm-cache'] as const)(
    'actual live shelf uses only replacement %s rows and the actual profile hook',
    async (mode) => {
      await start();
      const { BoardLiveSessionsBlock } = await import('../../../../components/live-sessions/BoardLiveSessionsBlock');
      const view = render(
        createElement(BoardLiveSessionsBlock, { boardId, boardUuid, holderName: null, holderUserId: null }),
        { wrapper },
      );
      await waitFor(() => expect(view.container.textContent).toContain('A-private-person'));
      await act(async () => {
        await replace('B');
        if (mode === 'warm-cache') await warmCurrent('board');
      });
      view.rerender(
        createElement(BoardLiveSessionsBlock, { boardId, boardUuid, holderName: null, holderUserId: null }),
      );
      await waitFor(() => expect(view.container.textContent).toContain('B-visible-person'));
      expect(view.container.textContent).not.toContain('A-private-person');
      expect(
        packets.filter((packet) => identify(packet.query) === 'profile').map((packet) => packet.owner?.userId),
      ).toEqual(['owned-A', 'owned-B']);
    },
  );
  it('a held retired SDK error cannot replace current B preview success', async () => {
    const current = await start();
    failGraphql = true;
    const blocked = hold('preview');
    const { result, rerender } = renderHook(
      () => ({ read: useRead('preview'), scope: current.queryScope.useHttpQueryScope() }),
      { wrapper },
    );
    await waitFor(() => expect(packets).toHaveLength(1));
    const oldKey = result.current.scope.key(logicalKey('preview'));
    failGraphql = false;
    await act(async () => {
      await replace('B');
    });
    rerender();
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
    blocked.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.read.data).toEqual(selected('preview', owner()));
    expect(result.current.read.error).toBeNull();
    expect(cache.getQueryData(oldKey)).toBeUndefined();
  });
  it('blurred selected B followed queries hide A and refetch immediately on refocus', async () => {
    await start();
    const { result, rerender } = renderHook(() => useRead('followed'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    state.focused = false;
    rerender();
    await act(async () => {
      await replace('B');
    });
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.data).toBeUndefined();
    expect(packets).toHaveLength(1);
    state.focused = true;
    rerender();
    await waitFor(() => expect(result.current.data).toEqual(selected('followed', owner())));
    expect(packets).toHaveLength(2);
  });
  it('actual selected polling renews normally without changing the view cache, and pauses offline', async () => {
    const current = await start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { result, rerender } = renderHook(
      () => ({ read: useRead('followed'), scope: current.queryScope.useHttpQueryScope() }),
      { wrapper },
    );
    for (let attempt = 0; attempt < 20 && !result.current.read.isSuccess; attempt += 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    expect(result.current.read.isSuccess).toBe(true);
    expect(packets).toHaveLength(1);
    expect(leaseCalls).toBe(1);
    const originalKey = result.current.scope.key(logicalKey('followed'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(packets).toHaveLength(2);
    clock = 120001;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(packets).toHaveLength(3);
    expect(leaseCalls).toBe(2);
    expect(result.current.scope.key(logicalKey('followed'))).toEqual(originalKey);
    expect(result.current.read.data).toEqual(selected('followed', owner()));
    state.offline = true;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(packets).toHaveLength(3);
  });
});
