// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' },
  openURL: vi.fn(),
  pickDocument: vi.fn(),
  fileText: vi.fn(),
  setClipboard: vi.fn(),
  showToast: vi.fn(),
  confirm: vi.fn(),
  flags: {} as Record<string, boolean | undefined>,
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('../../../components/integrations/LinkBoardAccountModal', () => ({ LinkBoardAccountModal: () => null }));
type RNProps = { children?: ReactNode; visible?: boolean };
vi.mock('react-native', () => ({
  View: ({ children }: RNProps) => createElement('div', {}, children),
  ScrollView: ({ children }: RNProps) => createElement('div', {}, children),
  KeyboardAvoidingView: ({ children }: RNProps) => createElement('div', {}, children),
  Modal: ({ visible, children }: RNProps) => (visible ? createElement('div', {}, children) : null),
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  TextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value?: string;
    onChangeText?: (next: string) => void;
    placeholder?: string;
  }) =>
    createElement('input', {
      value: value ?? '',
      'data-input': placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  Platform: mocks.platform,
  Linking: { openURL: mocks.openURL },
}));

vi.mock('expo-document-picker', () => ({ getDocumentAsync: mocks.pickDocument }));
vi.mock('expo-file-system', () => ({
  File: class File {
    private readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    text() {
      return mocks.fileText(this.uri);
    }

    async bytes() {
      return new TextEncoder().encode(await mocks.fileText(this.uri));
    }
  },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.setClipboard }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name != null ? `${key}:${opts.name}` : key),
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      secondaryLabel: '#888',
      tertiaryBackground: '#eee',
      fill: '#ddd',
    },
    brandColors: { primary: '#6D28D9', primaryFill: '#eee', onPrimary: '#fff', error: '#C81E1E', warning: '#F59E0B' },
    colorScheme: 'light',
  }),
}));

vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => mocks.flags[key],
}));

vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { md: 8, lg: 12, full: 999 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));

type TextProps = { children?: ReactNode; variant?: string };
vi.mock('../../../components/Text', () => ({
  Text: ({ children, variant }: TextProps) => createElement('span', { 'data-text-variant': variant }, children),
}));
vi.mock('../../../components/Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../../../components/SectionHeader', () => ({
  SectionHeader: () => createElement('div', { 'data-section-header': 'true' }),
}));

type ButtonProps = { title: string; onPress?: () => void; disabled?: boolean };
vi.mock('../../../components/Button', () => ({
  Button: ({ title, onPress, disabled }: ButtonProps) =>
    createElement('button', { 'data-button': title, disabled: !!disabled, onClick: onPress }),
}));

let runtime: {
  reads: typeof import('../use-board-account-reads');
  credentials: typeof import('../use-board-account-credentials');
  poll: typeof import('../use-pending-board-sync-poll');
  section: typeof import('../../../components/integrations/BoardAccountsSection');
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
}));
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
    section: await import('../../../components/integrations/BoardAccountsSection'),
    backend: await import('../../browser-backend-client.web'),
    clients: await import('../../graphql/client.web'),
    interceptor: await import('../../auth-interceptor.web'),
    admission: await import('../../browser-response-admission.web'),
  };
  await admit();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000 } } });
  auth.isAuthenticated = true;
});
afterEach(() => {
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
function credentialsQuery() {
  return cache
    .getQueryCache()
    .findAll()
    .filter((query) => query.queryKey.at(-1) === 'auroraCredentials');
}

describe('Aurora actual REST read observers', () => {
  it('original pending query expiry refuses old bytes despite a fresh independently live same-owner lease', async () => {
    const held = deferred<void>();
    reply = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ credentials: [credential('retired-expired-A')] })),
            );
            await held.promise;
            controller.close();
          },
        }),
      );
    const view = renderHook(() => runtime.credentials.useBoardAccountCredentials(), { wrapper });
    await waitFor(() => expect(packets).toHaveLength(1));
    clock = 120001;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    await act(async () => {
      held.resolve();
    });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.error).toMatchObject({ name: 'BrowserBackendConsumerError' });
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token);
    expect(scope).not.toBeNull();
    if (scope) runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh);
  });
  it('confirmed anonymous keeps real401 failure rather than a successful empty credentials DTO', async () => {
    state.anonymous = true;
    await act(async () => {
      await admit();
    });
    reply = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
    const view = renderHook(() => runtime.credentials.useBoardAccountCredentials(), { wrapper });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.error).toMatchObject({ name: 'BoardAccountError', code: 'unauthorized' });
    expect(view.result.current.data).toBeUndefined();
    expect(new Headers(packets[0]?.init?.headers).has('Authorization')).toBe(false);
  });
  it('wholly legacy preserves an ignored TanStack cancellation signal on observer unmount', async () => {
    const held = deferred<Response>();
    reply = () => held.promise;
    const view = renderHook(() => runtime.credentials.useBoardAccountCredentials(), { wrapper });
    await waitFor(() => expect(packets).toHaveLength(1));
    view.unmount();
    expect(packets[0]?.init?.signal?.aborted).toBe(false);
    await act(async () => {
      held.resolve(Response.json({ credentials: [credential('A')] }));
    });
    await waitFor(() => expect(cache.getQueryData(['auroraCredentials'])).toEqual({ credentials: [credential('A')] }));
  });
  it('wholly legacy keeps raw root/unsynced keys and original raw/projection shapes', async () => {
    reply = async () =>
      packets.at(-1)?.url.endsWith('/unsynced')
        ? Response.json({ counts: { tension: { ascents: 7, climbs: 4 } } })
        : Response.json({ credentials: [credential('A')] });
    const view = renderHook(
      () => {
        const credentials = runtime.reads.useAuroraCredentialsRead();
        const counts = runtime.reads.useAuroraUnsyncedRead(credentials.isSuccess);
        return { credentials, counts };
      },
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.counts.isSuccess).toBe(true));
    expect(cache.getQueryData(['auroraCredentials'])).toEqual({ credentials: [credential('A')] });
    expect(cache.getQueryData(['auroraCredentials', 'unsynced'])).toEqual({ tension: { ascents: 7, climbs: 4 } });
    expect(packets).toHaveLength(2);
    expect(new Headers(packets[0]?.init?.headers).get('Authorization')).toMatch(/^Bearer legacy-/);
  });

  it('all four observers share one raw physical cache and preserve default/offlineFirst options', async () => {
    reply = async () =>
      packets.at(-1)?.url.endsWith('/unsynced')
        ? Response.json({ counts: { tension: { ascents: 3, climbs: 2 } } })
        : Response.json({ credentials: [credential('A')] });
    const view = renderHook(
      () => {
        const raw = runtime.reads.useAuroraCredentialsRead();
        const selected = runtime.credentials.useBoardAccountCredentials();
        runtime.poll.usePendingBoardSyncPoll();
        const counts = runtime.reads.useAuroraUnsyncedRead(raw.isSuccess);
        return { raw, selected, counts };
      },
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.counts.data).toEqual({ tension: { ascents: 3, climbs: 2 } }));
    expect(view.result.current.raw.data).toEqual({ credentials: [credential('A')] });
    expect(view.result.current.selected.data).toEqual([credential('A')]);
    expect(packets).toHaveLength(2);
    expect(credentialsQuery()).toHaveLength(1);
    expect(credentialsQuery()[0]?.state.data).toEqual({ credentials: [credential('A')] });
    const observers = credentialsQuery()[0]?.getObserversCount();
    expect(observers).toBe(3);
    const all = cache.getQueryCache().findAll();
    const unsynced = all.find((query) => query.queryKey.at(-1) === 'unsynced');
    expect(unsynced?.options.networkMode).toBeUndefined();
  });
  it('actual BoardAccounts rows use A network then warm B cache, preserving no A row on replacement', async () => {
    reply = async () =>
      packets.at(-1)?.url.endsWith('/unsynced')
        ? Response.json({ counts: {} })
        : Response.json({ credentials: [credential(state.user)] });
    const displayed = render(createElement(runtime.section.BoardAccountsSection), { wrapper });
    await waitFor(() => expect(displayed.getByText('aurora.mobile.connectedAs:private-A')).toBeTruthy());
    displayed.unmount();
    await act(async () => {
      await change('B');
    });
    // Warm B through the actual query/service/operation, not invented cache authority.
    const warm = renderHook(
      () => {
        const credentials = runtime.reads.useAuroraCredentialsRead();
        const counts = runtime.reads.useAuroraUnsyncedRead(credentials.isSuccess);
        return { credentials, counts };
      },
      { wrapper },
    );
    await waitFor(() => expect(warm.result.current.counts.isSuccess).toBe(true));
    expect(warm.result.current.credentials.data?.credentials[0]?.auroraUsername).toBe('private-B');
    warm.unmount();
    const before = packets.length;
    const cached = render(createElement(runtime.section.BoardAccountsSection), { wrapper });
    expect(cached.getByText('aurora.mobile.connectedAs:private-B')).toBeTruthy();
    expect(cached.queryByText('aurora.mobile.connectedAs:private-A')).toBeNull();
    await act(async () => {});
    expect(packets).toHaveLength(before);
  });
  it.each(['B', 'ABA', 'SID', 'generation', 'version'])(
    'an earlier pending response cannot enter the replacement namespace: %s',
    async (kind) => {
      const held = deferred<Response>();
      reply = () => held.promise;
      const view = renderHook(() => runtime.credentials.useBoardAccountCredentials(), { wrapper });
      await waitFor(() => expect(packets).toHaveLength(1));
      await act(async () => {
        reply = async () => Response.json({ credentials: [credential('replacement')] });
        await change(kind);
        held.resolve(Response.json({ credentials: [credential('retired-A')] }));
      });
      await waitFor(() => expect(view.result.current.data?.[0]?.auroraUsername).toBe('private-replacement'));
      expect(
        cache
          .getQueryCache()
          .findAll()
          .some((query) => Boolean(JSON.stringify(query.state.data)?.includes('retired-A'))),
      ).toBe(false);
    },
  );
  it('unavailable selected view never adopts raw A poison or dispatches', async () => {
    await runtime.store.clearTokens();
    cache.setQueryData(['auroraCredentials'], { credentials: [credential('raw-A')] });
    const view = renderHook(() => runtime.credentials.useBoardAccountCredentials(), { wrapper });
    await act(async () => {});
    expect(view.result.current.data).toBeUndefined();
    expect(packets).toHaveLength(0);
  });
  it('disabled observers and a global poll without pending cache perform no credential or network I/O', async () => {
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    renderHook(
      () => {
        runtime.credentials.useBoardAccountCredentials(false);
        runtime.poll.usePendingBoardSyncPoll();
      },
      { wrapper },
    );
    await act(async () => {});
    expect(packets).toHaveLength(0);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
  });
  it('actual own-key BOOLEAN subscriber ignores raw/other-owner pending cache', async () => {
    cache.setQueryData(['auroraCredentials'], { credentials: [credential('raw-A', 'run')] });
    const current = renderHook(
      () => {
        runtime.poll.usePendingBoardSyncPoll();
        return runtime.rest.useRestView();
      },
      { wrapper },
    );
    await act(async () => {});
    expect(packets).toHaveLength(0);
    const oldKey = current.result.current.key(['auroraCredentials']);
    await act(async () => {
      await change('B');
    });
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      cache.setQueryData(oldKey, { credentials: [credential('A', 'run-A')] });
    });
    expect(packets).toHaveLength(0);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
  });
  it('function-valued20second poll starts from accepted own cache, renews normally and stops when cleared', async () => {
    vi.useFakeTimers();
    const scope = runtime.clients.browserHttpClients.captureRequestView();
    cache.setQueryData(key(scope), { credentials: [credential('A', 'run-A')] });
    reply = async () => Response.json({ credentials: [credential('A')] });
    renderHook(() => runtime.poll.usePendingBoardSyncPoll(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19999);
    });
    expect(packets).toHaveLength(0);
    clock = 120001;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(packets).toHaveLength(1);
    expect(cache.getQueryData(key(scope))).toEqual({ credentials: [credential('A')] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(packets).toHaveLength(1);
  });
  it('signed-out global observer does not poll its cached pending marker', async () => {
    vi.useFakeTimers();
    auth.isAuthenticated = false;
    const scope = runtime.clients.browserHttpClients.captureRequestView();
    cache.setQueryData(key(scope), { credentials: [credential('A', 'run')] });
    renderHook(() => runtime.poll.usePendingBoardSyncPoll(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(packets).toHaveLength(0);
  });
  it.each([403, 429, 500])(
    'ordinary current HTTP error retains existing BoardAccountError mapping: %s',
    async (status) => {
      reply = async () => Response.json({ error: 'private-api-error' }, { status });
      const view = renderHook(() => runtime.credentials.useBoardAccountCredentials(), { wrapper });
      await waitFor(() => expect(view.result.current.isError).toBe(true));
      expect(view.result.current.error).toMatchObject({
        name: 'BoardAccountError',
        code: status === 403 ? 'not_allowed' : status === 429 ? 'rate_limited' : 'request_failed',
      });
      expect(view.result.current.data).toBeUndefined();
    },
  );
  it('current decode failure is an error, never empty successful credentials', async () => {
    reply = async () => new Response('{');
    const view = renderHook(() => runtime.credentials.useBoardAccountCredentials(), { wrapper });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.error).toBeInstanceOf(SyntaxError);
    expect(view.result.current.data).toBeUndefined();
  });
  it('unsynced observer waits for this actual credentials success, never raw poison success', async () => {
    cache.setQueryData(['auroraCredentials'], { credentials: [credential('raw')] });
    reply = async () => new Response('{');
    renderHook(
      () => {
        const credentials = runtime.reads.useAuroraCredentialsRead();
        return runtime.reads.useAuroraUnsyncedRead(credentials.isSuccess);
      },
      { wrapper },
    );
    await waitFor(() => expect(packets).toHaveLength(1));
    await act(async () => {});
    expect(packets.every((packet) => !packet.url.endsWith('/unsynced'))).toBe(true);
  });
});
