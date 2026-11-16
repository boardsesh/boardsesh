// @vitest-environment jsdom
import { createElement, useLayoutEffect, useSyncExternalStore, Suspense, StrictMode, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_PROVIDER_SYNC } from '../../../lib/graphql/operations';
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
vi.mock('../../../lib/browser-consumer-readiness.web', () => ({
  publicExpoBrowserConsumersReady: () => state.required,
}));
vi.mock('../../../lib/browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: vi.fn(async () => {}) }));
vi.mock('../../../lib/auth-interceptor', () => ({
  setOnForcedSignOut: (...args: Parameters<typeof import('../../../lib/auth-interceptor.web').setOnForcedSignOut>) =>
    runtime.interceptor.setOnForcedSignOut(...args),
  authenticatedFetch: (...args: Parameters<typeof import('../../../lib/auth-interceptor.web').authenticatedFetch>) =>
    runtime.interceptor.authenticatedFetch(...args),
}));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn(), reportError: vi.fn() }));
vi.mock('../../../lib/env', () => ({
  BACKEND_URL: 'https://backend.owned.test/',
  WEB_BASE_URL: 'https://www.owned.test',
  webApiUrl: (path: string) => 'https://www.owned.test' + path,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'rest-owned' } } }));
vi.mock('../../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
  reportBackendOutcome: vi.fn(),
  setOfflineMode: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' },
  openURL: vi.fn(),
  pickDocument: vi.fn(),
  fileText: vi.fn(),
  setClipboard: vi.fn(),
  showToast: vi.fn(),
  confirm: vi.fn(),
  paperButtonActions: new Map<string, () => void>(),
  confirmationResults: [] as boolean[],
  flags: {} as Record<string, boolean | undefined>,
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
type RNProps = { children?: ReactNode; visible?: boolean };
vi.mock('react-native', () => ({
  View: ({
    children,
    accessibilityRole,
    accessibilityLiveRegion,
  }: RNProps & { accessibilityRole?: string; accessibilityLiveRegion?: string }) =>
    createElement('div', { role: accessibilityRole, 'aria-live': accessibilityLiveRegion }, children),
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
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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
  useTheme: () => {
    useSyncExternalStore(
      (listener) => {
        sync.themeListeners.add(listener);
        return () => sync.themeListeners.delete(listener);
      },
      () => sync.themeRevision,
      () => 0,
    );
    return {
      variant: sync.variant,
      m3: { error: '#f00' },
      systemColors: {
        secondaryBackground: '#fff',
        label: '#000',
        secondaryLabel: '#888',
        tertiaryBackground: '#eee',
        fill: '#ddd',
      },
      brandColors: {
        primary: '#6D28D9',
        primaryFill: '#eee',
        onPrimary: '#fff',
        error: '#C81E1E',
        success: '#047857',
        warning: '#F59E0B',
      },
      colorScheme: 'light',
    };
  },
}));

vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => mocks.flags[key],
}));

vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { md: 8, lg: 12, full: 999 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));

vi.mock('../../../components/Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) => {
    if (
      typeof children === 'string' &&
      /^aurora\.mobile\.syncNow(?:NotLinked|Unavailable|RateLimited)$/.test(children)
    ) {
      sync.renderedErrors.push(children);
      if (sync.suspendError && sync.errorGate) throw sync.errorGate.promise;
    }
    return createElement('span', { 'data-text-variant': variant }, children);
  },
}));
vi.mock('../../../components/Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../../../components/SectionHeader', () => ({
  SectionHeader: () => createElement('div', { 'data-section-header': 'true' }),
}));

let runtime: {
  operations: typeof import('../../../lib/graphql/http-operation.web');
  observable: typeof import('../../../lib/graphql/use-auth-token.web');
  watcher: typeof import('../../../lib/integrations/board-import-completion');
  authProvider: typeof import('../../../providers/auth-provider');
  hook: typeof import('../../../lib/integrations/use-unlink-board-account');
  toast: typeof import('../../../providers/toast-provider');
  dialog: typeof import('../../../providers/dialog-provider');
  reads: typeof import('../../../lib/integrations/use-board-account-reads');
  credentials: typeof import('../../../lib/integrations/use-board-account-credentials');
  poll: typeof import('../../../lib/integrations/use-pending-board-sync-poll');
  section: typeof import('../../../components/integrations/BoardAccountsSection');
  store: typeof import('../../../lib/auth-store.web');
  rest: typeof import('../../../lib/rest-operation.web');
  backend: typeof import('../../../lib/browser-backend-client.web');
  clients: typeof import('../../../lib/graphql/client.web');
  interceptor: typeof import('../../../lib/auth-interceptor.web');
  admission: typeof import('../../../lib/browser-response-admission.web');
};
let cache: QueryClient;
const auth = vi.hoisted(() => ({ isAuthenticated: true }));
const authFixture = vi.hoisted(() => ({
  actual: false,
  splash: 0,
  cleanupCalls: 0,
  cleanupGate: undefined as Promise<void> | undefined,
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false, reason: null }),
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => (authFixture.actual ? runtime.authProvider.useAuth() : auth),
}));
vi.mock('../../../lib/rest-operation', () => ({
  createRestOperation: (...args: Parameters<typeof import('../../../lib/rest-operation.web').createRestOperation>) => {
    querySignals.push(args[1]?.signal);
    return runtime.rest.createRestOperation(...args);
  },
  createUnlinkRestOperation: (
    ...args: Parameters<typeof import('../../../lib/rest-operation.web').createUnlinkRestOperation>
  ) => runtime.rest.createUnlinkRestOperation(...args),
  captureRestReadView: () => runtime.rest.captureRestReadView(),
  useRestView: () => runtime.rest.useRestView(),
}));
let clock: number;
let serial: number;
let packets: { url: string; init?: RequestInit }[];
let leases: Map<string, BrowserBackendLeaseOwner>;
let reply: () => Promise<Response>;
let deleteReply: () => Promise<Response>;
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
  mocks.paperButtonActions.clear();
  mocks.confirmationResults.length = 0;
  authFixture.actual = false;
  authFixture.splash = 0;
  authFixture.cleanupCalls = 0;
  authFixture.cleanupGate = undefined;
  sync.haptics = [];
  sync.buttons.clear();
  sync.nextButton = 0;
  syncOperations = [];
  sdkErrors = [];
  sync.captureErrors = false;
  sync.scopeSubscriptions = 0;
  sync.scopeReleases = 0;
  sync.onDeleted = undefined;
  sync.suspendError = false;
  sync.errorGate = undefined;
  sync.renderedErrors = [];
  sync.variant = 'material';
  sync.themeRevision = 0;
  querySignals = [];
  sdkPackets = [];
  getPackets = [];
  jobs = new Map();
  lastSync = '2026-01-01';
  heldLease = undefined;
  leaseHeld = false;
  heldLeaseResponse = undefined;
  leaseMs =
    /^(actual held GET acquisition|quiet error|queued error|independent error child|autonomous selected|original guarded retry)/.test(
      context.task.name,
    )
      ? 1000
      : 120000;
  clock = 0;
  serial = 0;
  packets = [];
  leases = new Map();
  sessionReply = undefined;
  reply = async () =>
    getPackets.at(-1)?.url.endsWith('/unsynced')
      ? Response.json({ counts: { tension: { ascents: 0, climbs: 0 }, decoy: { ascents: 0, climbs: 0 } } })
      : Response.json({ credentials: [credential(state.user, 'tension'), credential(state.user, 'decoy')] });
  deleteReply = async () => Response.json({ success: true });
  sdkReply = async (boardType) => {
    jobs.set(state.user + ':' + boardType, 'queued-' + boardType);
    return Response.json({
      data: { requestProviderSync: { runId: 'queued-' + boardType, status: 'queued', coalesced: false } },
    });
  };
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
        const response = Response.json({ status: 'admitted', token, usableForMs: leaseMs, owner: owner() });
        if (heldLease) {
          leaseHeld = true;
          heldLeaseResponse = response;
          return heldLease.promise;
        }
        return response;
      }
      if (url.endsWith('/api/auth/csrf')) return Response.json({ csrfToken: 'owned-csrf' });
      if (url.endsWith('/api/auth/signout')) return Response.json({ url: '/app' });
      if (url.endsWith('/graphql')) {
        if (typeof init?.body !== 'string') throw new Error('Expected actual SDK JSON body');
        const body = JSON.parse(init.body) as { query: string; variables: { boardType: string } };
        sdkPackets.push({ url, init: init ? { ...init, headers: new Headers(init.headers) } : undefined, body });
        return sdkReply(body.variables.boardType);
      }
      if (!url.startsWith('https://backend.owned.test/api/aurora-credentials'))
        throw new Error('Unexpected owned destination');
      packets.push({ url, init: init ? { ...init, headers: new Headers(init.headers) } : undefined });
      if (init?.method === 'DELETE') return deleteReply();
      getPackets.push({ url, init: init ? { ...init, headers: new Headers(init.headers) } : undefined });
      return reply();
    }),
  );
  const store = await import('../../../lib/auth-store.web');
  const rest = await import('../../../lib/rest-operation.web');
  runtime = {
    operations: await import('../../../lib/graphql/http-operation.web'),
    observable: await import('../../../lib/graphql/use-auth-token.web'),
    watcher: await import('../../../lib/integrations/board-import-completion'),
    authProvider: undefined as unknown as typeof import('../../../providers/auth-provider'),
    hook: await import('../../../lib/integrations/use-unlink-board-account'),
    toast: await import('../../../providers/toast-provider'),
    dialog: await import('../../../providers/dialog-provider'),
    store,
    rest,
    reads: await import('../../../lib/integrations/use-board-account-reads'),
    credentials: await import('../../../lib/integrations/use-board-account-credentials'),
    poll: await import('../../../lib/integrations/use-pending-board-sync-poll'),
    section: await import('../../../components/integrations/BoardAccountsSection'),
    backend: await import('../../../lib/browser-backend-client.web'),
    clients: await import('../../../lib/graphql/client.web'),
    interceptor: await import('../../../lib/auth-interceptor.web'),
    admission: await import('../../../lib/browser-response-admission.web'),
  };
  await admit();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000 } } });
  auth.isAuthenticated = true;
  stopWatcher = runtime.watcher.watchBoardImportCompletion(cache);
});
afterEach(() => {
  stopWatcher?.();
  onlineManager.setOnline(true);
  cleanup();
  sync.themeListeners.clear();
  cache?.clear();
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  // Restore spies on fake clock functions before restoring the real clock.
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function credential(user: string, boardType = 'tension') {
  return {
    boardType,
    auroraUsername: 'private-' + user + '-' + boardType,
    auroraUserId: 42,
    lastSyncAt: lastSync,
    syncStatus: 'active',
    syncError: null,
    pendingRunId: jobs.get(user + ':' + boardType) ?? null,
    syncAvailable: true,
    createdAt: '2026-01-01T00:00:00Z',
  };
}
function key(scope: string | undefined, logical: readonly unknown[] = ['auroraCredentials']) {
  return [...runtime.clients.browserHttpClients.queryKey([], scope), ...logical];
}
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({
      children,
      accessibilityRole,
      accessibilityLiveRegion,
    }: RNProps & { accessibilityRole?: string; accessibilityLiveRegion?: string }) =>
      createElement('div', { role: accessibilityRole, 'aria-live': accessibilityLiveRegion }, children),
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('../../../components/navigation/TabBarHideFollower', () => ({
  TabBarHideFollower: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../lib/haptics', () => ({
  hapticLight: () => sync.haptics.push('light'),
  hapticSuccess: () => sync.haptics.push('success'),
  hapticError: () => sync.haptics.push('error'),
}));
vi.mock('react-native-paper', () => {
  const Host = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Portal: Host,
    Dialog: Object.assign(
      ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
        visible ? createElement('div', { role: 'dialog' }, children) : null,
      { Title: Host, Content: Host, Actions: Host },
    ),
    Text: Host,
    Button: ({ children, onPress, disabled }: { children?: ReactNode; onPress: () => void; disabled?: boolean }) => {
      const id = ++sync.nextButton;
      sync.buttons.set(id, onPress);
      return createElement(
        'button',
        {
          'data-paper-id': id,
          'data-button': typeof children === 'string' ? children : '',
          disabled,
          onClick: onPress,
        },
        children,
      );
    },
    Snackbar: ({ children, visible, onDismiss }: { children?: ReactNode; visible: boolean; onDismiss: () => void }) =>
      visible
        ? createElement(
            'div',
            { 'data-snackbar': true },
            children,
            createElement('button', { 'data-dismiss': true, onClick: onDismiss }, 'dismiss-toast'),
          )
        : null,
  };
});
function PendingPoll() {
  runtime.poll.usePendingBoardSyncPoll();
  return null;
}
function App({
  showSection = true,
  strict = false,
  showPoll = false,
}: {
  showSection?: boolean;
  strict?: boolean;
  showPoll?: boolean;
}) {
  useLayoutEffect(() => {
    if (!showSection) sync.onDeleted?.();
  }, [showSection]);
  const content = createElement(
    QueryClientProvider,
    { client: cache },
    createElement(
      runtime.toast.ToastProvider,
      null,
      createElement(
        runtime.dialog.DialogProvider,
        null,
        showSection ? createElement(runtime.section.BoardAccountsSection) : null,
        showPoll ? createElement(PendingPoll) : null,
      ),
    ),
  );
  return createElement(
    Suspense,
    { fallback: createElement('p', { 'data-fallback': true }, 'held-render') },
    strict ? createElement(StrictMode, null, content) : content,
  );
}

const sync = vi.hoisted(() => ({
  haptics: [] as string[],
  buttons: new Map<number, () => void>(),
  nextButton: 0,
  captureErrors: false,
  scopeSubscriptions: 0,
  scopeReleases: 0,
  onDeleted: undefined as (() => void) | undefined,
  suspendError: false,
  errorGate: undefined as { promise: Promise<void>; resolve: () => void } | undefined,
  renderedErrors: [] as string[],
  variant: 'material' as 'material' | 'liquidGlass',
  themeRevision: 0,
  themeListeners: new Set<() => void>(),
}));
vi.mock('../../../components/Button', async () => await import('../../../components/Button.web'));
vi.mock('../../../theme/expo-ui-modifiers', () => ({
  brandAccentColor: (colors: { primary: string }) => colors.primary,
}));
vi.mock('../../../lib/graphql/http-operation', () => ({
  createHttpOperation: (
    ...args: Parameters<typeof import('../../../lib/graphql/http-operation.web').createHttpOperation>
  ) => {
    const operation = runtime.operations.createHttpOperation(...args);
    syncOperations.push(operation);
    if (!sync.captureErrors) return operation;
    const request = new Proxy(operation.request, {
      apply(target: typeof operation.request, receiver: unknown, args: unknown[]) {
        const pending = Reflect.apply(target, receiver, args) as Promise<unknown>;
        return pending.catch((error: unknown) => {
          sdkErrors.push(error);
          throw error;
        });
      },
    });
    return Object.freeze({ ...operation, request });
  },
}));
vi.mock('../../../lib/graphql/use-auth-token', () => ({
  subscribeHttpOperationScope: (listener: () => void) => {
    sync.scopeSubscriptions++;
    const release = runtime.observable.subscribeHttpOperationScope(listener);
    return () => {
      sync.scopeReleases++;
      release();
    };
  },
}));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: (...args: Parameters<typeof import('../../../lib/graphql/client.web').getHttpClient>) =>
    runtime.clients.getHttpClient(...args),
  resetHttpClient: () => runtime.clients.resetHttpClient(),
}));
let sdkErrors: unknown[];
let syncOperations: ReturnType<typeof import('../../../lib/graphql/http-operation.web').createHttpOperation>[];
let sdkPackets: { url: string; init?: RequestInit; body: { query: string; variables: { boardType: string } } }[];
let getPackets: { url: string; init?: RequestInit }[];
let sdkReply: (boardType: string) => Promise<Response>;
let jobs: Map<string, string>;
let lastSync: string;
let stopWatcher: (() => void) | undefined;
let heldLease: ReturnType<typeof deferred<Response>> | undefined;
let heldLeaseResponse: Response | undefined;
let leaseHeld: boolean;
let leaseMs: number;
let querySignals: (AbortSignal | undefined)[];
function syncButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-button="aurora.card.syncNow"]'));
}
function retryButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('[data-button="actions.retry"]')!;
}
async function loaded() {
  const view = render(createElement(App));
  await waitFor(() => expect(view.container.textContent).toContain('private-A-tension'));
  await waitFor(() => expect(syncButtons(view.container)).toHaveLength(2));
  return view;
}
function credentialGets() {
  return getPackets.filter((packet) => !packet.url.endsWith('/unsynced'));
}

function observeDom(container: HTMLElement) {
  const seen: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) seen.push(node.textContent ?? '');
      if (record.type === 'characterData') seen.push(record.target.textContent ?? '');
    }
  });
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}
async function themeChange() {
  await act(async () => {
    sync.themeRevision++;
    for (const listener of sync.themeListeners) listener();
  });
}
describe('Sync now actual SDK, Board, fixed REST and watcher', () => {
  it('current per-board singleflight and concurrent boards use one light haptic each and actual status GET', async () => {
    const view = await loaded();
    const heldTension = deferred<Response>();
    const heldDecoy = deferred<Response>();
    sdkReply = (board) => (board === 'tension' ? heldTension.promise : heldDecoy.promise);
    const buttons = syncButtons(view.container);
    const retained = sync.buttons.get(Number(buttons[0]!.dataset.paperId))!;
    act(() => {
      retained();
      retained();
      fireEvent.click(buttons[1]!);
    });
    await waitFor(() => expect(sdkPackets).toHaveLength(2));
    expect(sdkPackets.map((packet) => packet.body.variables.boardType).sort()).toEqual(['decoy', 'tension']);
    expect(sync.haptics).toEqual(['light', 'light']);
    jobs.set('A:tension', 'run-tension');
    jobs.set('A:decoy', 'run-decoy');
    await act(async () => {
      heldTension.resolve(
        Response.json({ data: { requestProviderSync: { runId: 'run-tension', status: 'queued', coalesced: false } } }),
      );
      heldDecoy.resolve(
        Response.json({ data: { requestProviderSync: { runId: 'run-decoy', status: 'queued', coalesced: true } } }),
      );
    });
    await waitFor(() =>
      expect(
        cache
          .getQueryData<{ credentials: { pendingRunId: string | null }[] }>(
            key(runtime.rest.captureRestReadView().scope),
          )
          ?.credentials.every((credential) => credential.pendingRunId),
      ).toBe(true),
    );
    expect(sync.haptics).toEqual(['light', 'light']);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(credentialGets().length).toBeGreaterThanOrEqual(2);
    expect(sdkPackets).toHaveLength(2);
  });
  it.each([false, true])(
    'actual held GET acquisition current positive / expired original SDK E1 (%s)',
    async (expired) => {
      const view = await loaded();
      const initialGets = credentialGets().length;
      sdkReply = async (board) => {
        jobs.set('A:' + board, 'held-run');
        clock = 900;
        heldLease = deferred<Response>();
        return Response.json({
          data: { requestProviderSync: { runId: 'held-run', status: 'queued', coalesced: false } },
        });
      };
      fireEvent.click(syncButtons(view.container)[0]!);
      await waitFor(() => expect(leaseHeld).toBe(true));
      expect(sdkPackets).toHaveLength(1);
      expect(syncOperations).toHaveLength(1);
      expect(() => syncOperations[0]!.assertDeliveries()).not.toThrow();
      const tokenE1 = new Headers(sdkPackets[0]!.init?.headers).get('Authorization');
      const freshPending = runtime.backend.expoBrowserBackendClient.acquire(owner());
      if (expired) clock = 1001;
      if (expired) expect(() => syncOperations[0]!.assertDeliveries()).toThrow();
      let fresh!: Awaited<typeof freshPending>;
      await act(async () => {
        const gate = heldLease!;
        heldLease = undefined;
        gate.resolve(heldLeaseResponse!);
        fresh = await freshPending;
      });
      const actualScope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
      expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(actualScope, fresh)).not.toThrow();
      expect(fresh.token).not.toBe(tokenE1?.slice(7));
      await waitFor(() => expect(sync.scopeReleases).toBe(1));
      expect(credentialGets().length - initialGets).toBe(expired ? 0 : 1);
      await waitFor(() => expect(syncButtons(view.container)[0]?.disabled).toBe(expired ? false : true));
      expect(sdkPackets).toHaveLength(1);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it('fixed original onFetch resists cache fetch reentrancy replacing later queryFn', async () => {
    const view = await loaded();
    const initialGets = credentialGets().length;
    let replacements = 0;
    let forbidden = 0;
    let arm = true;
    const release = cache.getQueryCache().subscribe((event) => {
      if (
        arm &&
        event.type === 'updated' &&
        event.action.type === 'fetch' &&
        event.query.queryKey.at(-1) === 'auroraCredentials'
      ) {
        arm = false;
        replacements++;
        event.query.setOptions({
          ...event.query.options,
          queryFn: async () => {
            forbidden++;
            return { credentials: [] };
          },
        });
      }
    });
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(credentialGets().length - initialGets).toBe(1));
    await waitFor(() => expect(syncButtons(view.container)[0]?.disabled).toBe(true));
    expect(replacements).toBe(1);
    expect(forbidden).toBe(0);
    expect(sdkPackets).toHaveLength(1);
    release();
  });
  it('offline paused original refresh cannot send a GET after actual selected owner replacement', async () => {
    const view = await loaded();
    const tokenA = new Headers(credentialGets()[0]!.init?.headers).get('Authorization');
    sdkReply = async (board) => {
      jobs.set('A:' + board, 'paused-run');
      onlineManager.setOnline(false);
      return Response.json({
        data: { requestProviderSync: { runId: 'paused-run', status: 'queued', coalesced: false } },
      });
    };
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() =>
      expect(cache.getQueryState(key(runtime.rest.captureRestReadView().scope))?.fetchStatus).toBe('paused'),
    );
    const before = credentialGets().length;
    await act(async () => {
      await change('B');
      onlineManager.setOnline(true);
    });
    await waitFor(() => expect(view.container.textContent).toContain('private-B-tension'));
    expect(
      credentialGets()
        .slice(before)
        .some((packet) => new Headers(packet.init?.headers).get('Authorization') === tokenA),
    ).toBe(false);
    expect(sdkPackets).toHaveLength(1);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
  it('a prequeue pending GET is joined without cancel then followed by one actual fresh status read', async () => {
    const view = await loaded();
    const scope = runtime.rest.captureRestReadView().scope;
    const original = reply;
    const held = deferred<Response>();
    let hold = true;
    reply = () => (hold ? held.promise : original());
    const prequeue = cache.refetchQueries({ queryKey: key(scope), exact: true });
    await waitFor(() => expect(credentialGets()).toHaveLength(2));
    const oldSignal = credentialGets()[1]!.init?.signal;
    const oldQuerySignal = querySignals.at(-1);
    expect(oldQuerySignal).toBeDefined();
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(sdkPackets).toHaveLength(1));
    expect(oldSignal?.aborted).toBe(false);
    hold = false;
    await act(async () => {
      held.resolve(
        Response.json({
          credentials: [{ ...credential('A', 'tension'), pendingRunId: null }, credential('A', 'decoy')],
        }),
      );
      await prequeue;
    });
    await waitFor(() => expect(credentialGets()).toHaveLength(3));
    await waitFor(() =>
      expect(
        cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(key(scope))?.credentials[0]
          ?.pendingRunId,
      ).toBe('queued-tension'),
    );
    expect(oldSignal?.aborted).toBe(true);
    expect(oldQuerySignal?.aborted).toBe(false);
    expect(sdkPackets).toHaveLength(1);
  });
  it('only a later independently admitted completed GET triggers existing import invalidation', async () => {
    const view = await loaded();
    const invalidations = vi.spyOn(cache, 'invalidateQueries');
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(credentialGets()).toHaveLength(2));
    expect(invalidations.mock.calls.every(([filters]) => filters?.queryKey?.at(-1) === 'auroraCredentials')).toBe(true);
    jobs.clear();
    lastSync = '2026-02-01';
    await act(async () => {
      await cache.refetchQueries({ queryKey: key(runtime.rest.captureRestReadView().scope), exact: true });
    });
    await waitFor(() =>
      expect(invalidations.mock.calls.some(([filters]) => filters?.queryKey?.includes('userTicks'))).toBe(true),
    );
    expect(sdkPackets).toHaveLength(1);
  });
  it('retained actual status Retry forces a new read even after an independent current GET made cache fresh', async () => {
    reply = async () => Response.json({ error: 'temporary' }, { status: 500 });
    const view = render(createElement(App));
    await waitFor(() => expect(retryButton(view.container)).toBeTruthy());
    const retained = sync.buttons.get(Number(retryButton(view.container).dataset.paperId))!;
    reply = async () => Response.json({ credentials: [credential('A', 'tension'), credential('A', 'decoy')] });
    await act(async () => {
      await cache.refetchQueries({ queryKey: key(runtime.rest.captureRestReadView().scope), exact: true });
    });
    await waitFor(() => expect(view.container.textContent).toContain('private-A-tension'));
    const before = credentialGets().length;
    act(() => {
      retained();
    });
    await waitFor(() => expect(credentialGets().length).toBe(before + 1));
    expect(sdkPackets).toHaveLength(0);
    expect(sync.haptics).toEqual(['light']);
  });
  it.each([
    ['RATE_LIMITED', 'aurora.mobile.syncNowRateLimited', 'warning'],
    ['PROVIDER_SYNC_UNAVAILABLE', 'aurora.mobile.syncNowUnavailable', 'error'],
    ['PROVIDER_NOT_LINKED', 'aurora.mobile.syncNowNotLinked', 'error'],
  ] as const)('authentic original SDK error %s alone guides current feedback', async (code, message, variant) => {
    const view = await loaded();
    sync.captureErrors = true;
    const gets = credentialGets().length;
    const invalidations = vi.spyOn(cache, 'invalidateQueries');
    sdkReply = async () => Response.json({ errors: [{ message: 'private provider error', extensions: { code } }] });
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(message));
    expect(sdkErrors).toHaveLength(1);
    expect(() => syncOperations[0]!.assertErrorDeliveries(sdkErrors[0])).not.toThrow();
    const copied = { ...(sdkErrors[0] as object) };
    expect(() => syncOperations[0]!.assertErrorDeliveries(copied)).toThrow();
    expect(view.container.textContent).not.toContain('private provider error');
    expect(sdkPackets).toHaveLength(1);
    expect(credentialGets()).toHaveLength(gets);
    expect(invalidations).not.toHaveBeenCalled();
    expect(sync.haptics).toEqual(variant === 'error' ? ['light', 'error'] : ['light']);
    fireEvent.click(view.container.querySelector('[data-dismiss]')!);
    expect(sync.scopeSubscriptions).toBe(1);
    expect(sync.scopeReleases).toBe(1);
  });
  it('unknown SDK transport errors never create mutation guidance or status refresh', async () => {
    const view = await loaded();
    sync.captureErrors = true;
    const gets = credentialGets().length;
    sdkReply = async () => {
      throw new Error('private network diagnostic');
    };
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(sdkPackets).toHaveLength(1));
    await waitFor(() => expect(sync.scopeReleases).toBe(1));
    expect(sdkErrors).toHaveLength(1);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).not.toContain('private network diagnostic');
    expect(credentialGets()).toHaveLength(gets);
    expect(sync.haptics).toEqual(['light']);
  });
  it('post-success cache failure cannot be reclassified as authentic SDK mutation guidance', async () => {
    const view = await loaded();
    const external = runtime.operations.createHttpOperation(runtime.rest.captureRestReadView().scope);
    let foreign: unknown;
    sdkReply = async () =>
      Response.json({ errors: [{ message: 'real external cause', extensions: { code: 'RATE_LIMITED' } }] });
    try {
      await external.request(REQUEST_PROVIDER_SYNC, { boardType: 'tension' });
    } catch (error) {
      foreign = error;
    }
    expect(foreign).toBeDefined();
    expect(() => external.assertErrorDeliveries(foreign)).not.toThrow();
    sdkReply = async () =>
      Response.json({ data: { requestProviderSync: { runId: 'queued', status: 'queued', coalesced: false } } });
    vi.spyOn(cache, 'invalidateQueries').mockRejectedValue(foreign);
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(sdkPackets).toHaveLength(2));
    await waitFor(() => expect(sync.scopeReleases).toBe(1));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(sync.haptics).toEqual(['light']);
    expect(credentialGets()).toHaveLength(1);
    external.dispose();
  });
  it('quiet error E1 expires under actual live E2 with one bounded no-I/O sampler and cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const clears = vi.spyOn(globalThis, 'clearInterval');
    const view = await loaded();
    sync.captureErrors = true;
    sdkReply = async () =>
      Response.json({ errors: [{ message: 'private original error', extensions: { code: 'RATE_LIMITED' } }] });
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('aurora.mobile.syncNowRateLimited'),
    );
    await act(async () => {});
    const samplers = intervals.mock.calls
      .map((args, index) => ({ args, result: intervals.mock.results[index] }))
      .filter((call) => call.args[1] === 100);
    expect(samplers).toHaveLength(1);
    const before = { sdk: sdkPackets.length, get: getPackets.length, serial, buttons: sync.nextButton };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect({ sdk: sdkPackets.length, get: getPackets.length, serial, buttons: sync.nextButton }).toEqual(before);
    clock = 900;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
    clock = 1001;
    expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
    expect(() => syncOperations[0]!.assertErrorDeliveries(sdkErrors[0])).toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(sync.scopeSubscriptions).toBe(1);
    expect(sync.scopeReleases).toBe(1);
    const handle = samplers[0]!.result.value;
    expect(clears.mock.calls.filter((args) => args[0] === handle)).toHaveLength(1);
    const after = { sdk: sdkPackets.length, get: getPackets.length, serial };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect({ sdk: sdkPackets.length, get: getPackets.length, serial }).toEqual(after);
  });
  it.each(['auth', 'backend', 'registry'] as const)(
    'actual %s notification retires error feedback before the quiet sampler',
    async (kind) => {
      const view = await loaded();
      sync.captureErrors = true;
      sdkReply = async () =>
        Response.json({ errors: [{ message: 'private cause', extensions: { code: 'RATE_LIMITED' } }] });
      fireEvent.click(syncButtons(view.container)[0]!);
      await waitFor(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
      await act(async () => {
        if (kind === 'auth') await runtime.store.clearTokens();
        else if (kind === 'backend') runtime.backend.expoBrowserBackendClient.retire();
        else runtime.clients.resetHttpClient();
      });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(sync.scopeReleases).toBe(1);
      expect(sdkPackets).toHaveLength(1);
    },
  );
  it('actual Board deletion retires error authority before layout without insertion React updates', async () => {
    const view = await loaded();
    sync.captureErrors = true;
    sdkReply = async () =>
      Response.json({ errors: [{ message: 'private cause', extensions: { code: 'RATE_LIMITED' } }] });
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(() => syncOperations[0]!.assertErrorDeliveries(sdkErrors[0])).not.toThrow();
    let retiredAtLayout = false;
    const logs: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    sync.onDeleted = () => {
      try {
        syncOperations[0]!.assertErrorDeliveries(sdkErrors[0]);
      } catch {
        retiredAtLayout = true;
      }
    };
    await act(async () => {
      view.rerender(createElement(App, { showSection: false }));
    });
    expect(retiredAtLayout).toBe(true);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      logs.some((args) =>
        args.some(
          (value) => typeof value === 'string' && value.includes('useInsertionEffect must not schedule updates'),
        ),
      ),
    ).toBe(false);
    expect(sync.scopeReleases).toBe(1);
    expect(sdkPackets).toHaveLength(1);
  });
  it('actual observable import/subscription/release performs no credential or network work', () => {
    const before = { serial, sdk: sdkPackets.length, get: getPackets.length };
    let notifications = 0;
    const release = runtime.observable.subscribeHttpOperationScope(() => {
      notifications++;
    });
    expect({ serial, sdk: sdkPackets.length, get: getPackets.length }).toEqual(before);
    runtime.clients.resetHttpClient();
    expect(notifications).toBeGreaterThan(0);
    const count = notifications;
    release();
    runtime.clients.resetHttpClient();
    expect(notifications).toBe(count);
    expect({ serial, sdk: sdkPackets.length, get: getPackets.length }).toEqual(before);
  });
  it.each(['current', 'B', 'E1'] as const)(
    'queued error first commit %s retains only the original real SDK cause',
    async (kind) => {
      const view = await loaded();
      const observed = observeDom(view.container);
      sync.captureErrors = true;
      sync.suspendError = true;
      sync.errorGate = deferred<void>();
      const message = 'aurora.mobile.syncNowNotLinked';
      sdkReply = async () =>
        Response.json({
          errors: [{ message: 'private queued guidance', extensions: { code: 'PROVIDER_NOT_LINKED' } }],
        });
      fireEvent.click(syncButtons(view.container)[0]!);
      await waitFor(() => expect(sync.renderedErrors).toContain(message));
      expect(sdkErrors).toHaveLength(1);
      expect(() => syncOperations[0]!.assertErrorDeliveries(sdkErrors[0])).not.toThrow();
      expect(observed.seen.some((text) => text.includes(message))).toBe(false);
      expect(sync.scopeReleases).toBe(0);
      if (kind === 'B')
        await act(async () => {
          await change('B');
        });
      if (kind === 'E1') {
        clock = 900;
        const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
        const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
        clock = 1001;
        expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
        expect(() => syncOperations[0]!.assertErrorDeliveries(sdkErrors[0])).toThrow();
      }
      sync.suspendError = false;
      await act(async () => {
        sync.errorGate!.resolve();
      });
      if (kind === 'current') {
        await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(message));
        expect(observed.seen.some((text) => text.includes(message))).toBe(true);
        expect(sync.haptics).toEqual(['light', 'error']);
        expect(sync.scopeReleases).toBe(0);
        fireEvent.click(view.container.querySelector('[data-dismiss]')!);
        expect(sync.scopeReleases).toBe(1);
      } else {
        expect(observed.seen.some((text) => text.includes(message))).toBe(false);
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
        expect(sync.haptics).toEqual(['light']);
      }
      expect(sdkPackets).toHaveLength(1);
      observed.stop();
    },
  );
  it('StrictMode current error commits once and releases its exact proof only on dismissal', async () => {
    const view = render(createElement(App, { strict: true }));
    await waitFor(() => expect(syncButtons(view.container)).toHaveLength(2));
    sync.captureErrors = true;
    sdkReply = async () =>
      Response.json({ errors: [{ message: 'private strict cause', extensions: { code: 'PROVIDER_NOT_LINKED' } }] });
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('aurora.mobile.syncNowNotLinked'),
    );
    expect(sync.haptics).toEqual(['light', 'error']);
    expect(sdkPackets).toHaveLength(1);
    expect(sync.scopeSubscriptions).toBe(1);
    expect(sync.scopeReleases).toBe(0);
    expect(() => syncOperations[0]!.assertErrorDeliveries(sdkErrors[0])).not.toThrow();
    fireEvent.click(view.container.querySelector('[data-dismiss]')!);
    expect(sync.scopeReleases).toBe(1);
  });
  it.each(['material', 'liquidGlass'] as const)(
    'independent error child %s rerender directly rejects E1 before its quiet tick',
    async (variant) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      sync.variant = variant;
      const view = await loaded();
      sync.captureErrors = true;
      sdkReply = async () =>
        Response.json({ errors: [{ message: 'private child cause', extensions: { code: 'PROVIDER_NOT_LINKED' } }] });
      fireEvent.click(syncButtons(view.container)[0]!);
      await waitFor(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
      clock = 900;
      const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
      const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
      clock = 1001;
      expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
      await themeChange();
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(sdkPackets).toHaveLength(1);
      expect(sync.scopeReleases).toBe(1);
    },
  );
  it.each(['B', 'ABA', 'SID', 'version', 'generation'] as const)(
    'retained actual selected Button refuses %s before haptic, pending, SDK or refresh',
    async (kind) => {
      const view = await loaded();
      const button = syncButtons(view.container)[0]!;
      const retained = sync.buttons.get(Number(button.dataset.paperId))!;
      await act(async () => {
        await change(kind);
      });
      await waitFor(() => expect(syncButtons(view.container)).toHaveLength(2));
      const before = { sdk: sdkPackets.length, get: getPackets.length, serial };
      act(() => {
        retained();
      });
      await act(async () => {});
      expect(sync.haptics).toEqual([]);
      expect({ sdk: sdkPackets.length, get: getPackets.length, serial }).toEqual(before);
      expect(sync.scopeSubscriptions).toBe(0);
      expect(syncButtons(view.container).every((button) => !button.disabled)).toBe(true);
    },
  );
  it('retained actual status Retry cannot send or haptic for a replacement owner', async () => {
    reply = async () => Response.json({ error: 'temporary' }, { status: 500 });
    const view = render(createElement(App));
    await waitFor(() => expect(retryButton(view.container)).toBeTruthy());
    const retained = sync.buttons.get(Number(retryButton(view.container).dataset.paperId))!;
    reply = async () =>
      Response.json({ credentials: [credential(state.user, 'tension'), credential(state.user, 'decoy')] });
    await act(async () => {
      await change('B');
    });
    await waitFor(() => expect(view.container.textContent).toContain('private-B-tension'));
    const before = { sdk: sdkPackets.length, get: getPackets.length, serial };
    act(() => {
      retained();
    });
    await act(async () => {});
    expect({ sdk: sdkPackets.length, get: getPackets.length, serial }).toEqual(before);
    expect(sync.haptics).toEqual([]);
  });
  it('old terminal removal cannot clear a newer same-board request under the replacement owner', async () => {
    const view = await loaded();
    const first = deferred<Response>();
    const second = deferred<Response>();
    sdkReply = () => (state.user === 'A' ? first.promise : second.promise);
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(sdkPackets).toHaveLength(1));
    await act(async () => {
      await change('B');
    });
    await waitFor(() => expect(view.container.textContent).toContain('private-B-tension'));
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(sdkPackets).toHaveLength(2));
    expect(syncButtons(view.container)[0]?.disabled).toBe(true);
    const before = credentialGets().length;
    await act(async () => {
      first.resolve(
        Response.json({ data: { requestProviderSync: { runId: 'retired-A', status: 'queued', coalesced: false } } }),
      );
    });
    await act(async () => {});
    expect(syncButtons(view.container)[0]?.disabled).toBe(true);
    expect(credentialGets()).toHaveLength(before);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    jobs.set('B:tension', 'current-B');
    await act(async () => {
      second.resolve(
        Response.json({ data: { requestProviderSync: { runId: 'current-B', status: 'queued', coalesced: false } } }),
      );
    });
    await waitFor(() =>
      expect(
        cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(
          key(runtime.rest.captureRestReadView().scope),
        )?.credentials[0]?.pendingRunId,
      ).toBe('current-B'),
    );
    expect(sdkPackets).toHaveLength(2);
  });
  it('cache-added reentrancy cannot replace an actual fixed original REST execution', async () => {
    const read = renderHook(() => runtime.reads.useAuroraCredentialsRead({ enabled: false }), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(QueryClientProvider, { client: cache }, children),
    });
    const original = read.result.current.originalCredentialsRead;
    read.unmount();
    cache.removeQueries({ queryKey: original.view.key(['auroraCredentials']), exact: true });
    const operation = runtime.operations.createHttpOperation(original.view.scope);
    await operation.request(REQUEST_PROVIDER_SYNC, { boardType: 'tension' });
    operation.assertDeliveries();
    let added = 0;
    let forbidden = 0;
    const release = cache.getQueryCache().subscribe((event) => {
      if (event.type === 'added' && event.query.queryKey.at(-1) === 'auroraCredentials') {
        added++;
        event.query.setOptions({
          ...event.query.options,
          queryFn: async () => {
            forbidden++;
            return { credentials: [] };
          },
        });
      }
    });
    await original.refreshAfterSync(operation.assertDeliveries);
    expect(added).toBe(1);
    expect(forbidden).toBe(0);
    expect(credentialGets()).toHaveLength(1);
    expect(
      cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(original.view.key(['auroraCredentials']))
        ?.credentials[0]?.pendingRunId,
    ).toBe('queued-tension');
    expect(sdkPackets).toHaveLength(1);
    release();
    operation.dispose();
  });
  it('a completed temporary refresh releases E1 from later independent no-observer reads', async () => {
    const read = renderHook(() => runtime.reads.useAuroraCredentialsRead({ enabled: false }), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(QueryClientProvider, { client: cache }, children),
    });
    const original = read.result.current.originalCredentialsRead;
    const queryKey = original.view.key(['auroraCredentials']);
    read.unmount();
    cache.removeQueries({ queryKey, exact: true });
    const operation = runtime.operations.createHttpOperation(original.view.scope);
    await operation.request(REQUEST_PROVIDER_SYNC, { boardType: 'tension' });
    operation.assertDeliveries();
    await original.refreshAfterSync(operation.assertDeliveries);
    expect(credentialGets()).toHaveLength(1);
    operation.dispose();
    expect(() => operation.assertDeliveries()).toThrow();
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
    expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
    let failure: unknown;
    try {
      await cache.refetchQueries({ queryKey, exact: true }, { throwOnError: true });
    } catch (error) {
      failure = error;
    }
    expect(credentialGets()).toHaveLength(2);
    expect(failure).toBeUndefined();
    expect(
      cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(queryKey)?.credentials[0]?.pendingRunId,
    ).toBe('queued-tension');
    expect(sdkPackets).toHaveLength(1);
  });
  it('a temporary invocation preserves reentrant newer actual reader options and authority', async () => {
    const wrapper = ({ children }: { children?: ReactNode }) =>
      createElement(QueryClientProvider, { client: cache }, children);
    const first = renderHook(() => runtime.reads.useAuroraCredentialsRead({ enabled: false }), { wrapper });
    const original = first.result.current.originalCredentialsRead;
    const queryKey = original.view.key(['auroraCredentials']);
    first.unmount();
    const newer = renderHook(() => runtime.reads.useAuroraCredentialsRead({ enabled: false, networkMode: 'always' }), {
      wrapper,
    });
    const newerOptions = cache.getQueryCache().find({ queryKey, exact: true })!.options;
    const newerMeta = Object.freeze({ owner: 'newer-reader' });
    newer.unmount();
    cache.removeQueries({ queryKey, exact: true });
    let replacements = 0;
    const release = cache.getQueryCache().subscribe((event) => {
      if (
        !replacements &&
        event.type === 'updated' &&
        event.action.type === 'fetch' &&
        event.query.queryKey.at(-1) === 'auroraCredentials'
      ) {
        replacements++;
        event.query.setOptions({ ...newerOptions, meta: newerMeta });
      }
    });
    const operation = runtime.operations.createHttpOperation(original.view.scope);
    await operation.request(REQUEST_PROVIDER_SYNC, { boardType: 'tension' });
    const held = deferred<Response>();
    const ordinaryReply = reply;
    reply = () => held.promise;
    const refresh = original.refreshAfterSync(operation.assertDeliveries);
    await waitFor(() => expect(credentialGets()).toHaveLength(1));
    const query = cache.getQueryCache().find({ queryKey, exact: true })!;
    expect(replacements).toBe(1);
    expect(query.options.queryFn).toBe(newerOptions.queryFn);
    expect(query.options.behavior).toBe(newerOptions.behavior);
    expect(query.options.networkMode).toBe('always');
    expect(query.options.meta).toBe(newerMeta);
    reply = ordinaryReply;
    await act(async () => {
      held.resolve(await ordinaryReply());
      await refresh;
    });
    operation.dispose();
    expect(query.options.queryFn).toBe(newerOptions.queryFn);
    expect(query.options.networkMode).toBe('always');
    expect(query.options.meta).toBe(newerMeta);
    await cache.refetchQueries({ queryKey, exact: true }, { throwOnError: true });
    expect(credentialGets()).toHaveLength(2);
    expect(sdkPackets).toHaveLength(1);
    release();
  });
  it('joining an independent paused read never grafts E1 onto its options or resumed GET', async () => {
    const wrapper = ({ children }: { children?: ReactNode }) =>
      createElement(QueryClientProvider, { client: cache }, children);
    const first = renderHook(() => runtime.reads.useAuroraCredentialsRead({ enabled: false }), { wrapper });
    const original = first.result.current.originalCredentialsRead;
    const queryKey = original.view.key(['auroraCredentials']);
    first.unmount();
    const independent = renderHook(() => runtime.reads.useAuroraCredentialsRead(), { wrapper });
    await waitFor(() => expect(independent.result.current.isSuccess).toBe(true));
    const query = cache.getQueryCache().find({ queryKey, exact: true })!;
    const independentOptions = query.options;
    const independentFn = independentOptions.queryFn;
    const independentBehavior = independentOptions.behavior;
    // Keep the real QueryClient online subscription while this ordinary read
    // has no React observer capable of replacing options on every result render.
    const anchor = render(createElement(QueryClientProvider, { client: cache }, createElement('div')));
    independent.unmount();
    const operation = runtime.operations.createHttpOperation(original.view.scope);
    await operation.request(REQUEST_PROVIDER_SYNC, { boardType: 'tension' });
    onlineManager.setOnline(false);
    const pending = query.fetch(independentOptions, { cancelRefetch: false });
    await waitFor(() => expect(query.state.fetchStatus).toBe('paused'));
    let finished = false;
    const refresh = original.refreshAfterSync(operation.assertDeliveries).then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await act(async () => {});
    expect(query.options.queryFn).toBe(independentFn);
    expect(query.options.behavior).toBe(independentBehavior);
    operation.dispose();
    expect(() => operation.assertDeliveries()).toThrow();
    const before = credentialGets().length;
    await act(async () => {
      onlineManager.setOnline(true);
      await pending;
      await refresh;
    });
    await waitFor(() => expect(query.state.fetchStatus).toBe('idle'));
    expect(finished).toBe(true);
    expect(credentialGets()).toHaveLength(before + 1);
    expect(
      cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(queryKey)?.credentials[0]?.pendingRunId,
    ).toBe('queued-tension');
    expect(sdkPackets).toHaveLength(1);
    anchor.unmount();
  });
  it('original guarded retry keeps E1 after future options are detached', async () => {
    const wrapper = ({ children }: { children?: ReactNode }) =>
      createElement(QueryClientProvider, { client: cache }, children);
    const reader = renderHook(() => runtime.reads.useAuroraCredentialsRead({ enabled: false }), { wrapper });
    const original = reader.result.current.originalCredentialsRead;
    const queryKey = original.view.key(['auroraCredentials']);
    const anchor = render(createElement(QueryClientProvider, { client: cache }, createElement('div')));
    reader.unmount();
    cache.setQueryDefaults(queryKey, { retry: 1, retryDelay: 0 });
    const operation = runtime.operations.createHttpOperation(original.view.scope);
    await operation.request(REQUEST_PROVIDER_SYNC, { boardType: 'tension' });
    operation.assertDeliveries();
    const ordinaryReply = reply;
    reply = async () => {
      onlineManager.setOnline(false);
      return Response.json({ error: 'temporary status failure' }, { status: 500 });
    };
    const settled = original.refreshAfterSync(operation.assertDeliveries).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
    const query = cache.getQueryCache().find({ queryKey, exact: true })!;
    await waitFor(() => expect(query.state.fetchStatus).toBe('paused'));
    expect(credentialGets()).toHaveLength(1);
    expect(query.options.behavior).toBeUndefined();
    clock = 900;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
    clock = 1001;
    expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
    expect(() => operation.assertDeliveries()).toThrow();
    reply = ordinaryReply;
    let outcome: { ok: boolean } | undefined;
    await act(async () => {
      onlineManager.setOnline(true);
      outcome = await settled;
    });
    expect(outcome).toEqual({ ok: false });
    expect(credentialGets()).toHaveLength(1);
    expect(sdkPackets).toHaveLength(1);
    operation.dispose();
    await cache.refetchQueries({ queryKey, exact: true }, { throwOnError: true });
    expect(credentialGets()).toHaveLength(2);
    anchor.unmount();
  });
  it('autonomous selected 20-second global poll completes once after Sync E1 release and expiry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const view = await loaded();
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() => expect(credentialGets()).toHaveLength(2));
    await waitFor(() => expect(sync.scopeReleases).toBe(1));
    const command = syncOperations[0]!;
    expect(() => command.assertDeliveries()).toThrow();
    const sdkBearer = new Headers(sdkPackets[0]!.init?.headers).get('Authorization');
    const scope = runtime.rest.captureRestReadView().scope;
    expect(
      cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(key(scope))?.credentials[0]?.pendingRunId,
    ).toBe('queued-tension');
    await act(async () => {
      view.rerender(createElement(App, { showSection: false, showPoll: true }));
    });
    expect(credentialGets()).toHaveLength(2);
    clock = 900;
    leaseMs = 30_000;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    const actual = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
    clock = 1001;
    expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(actual, fresh)).not.toThrow();
    expect('Bearer ' + fresh.token).not.toBe(sdkBearer);
    const observations: { current: boolean; scope: string; pending: (string | null | undefined)[] }[] = [];
    const release = runtime.reads.subscribeToAcceptedBoardAccountReads(cache, (observation) => {
      let current = false;
      try {
        observation.assertCurrent();
        current = true;
      } catch {
        /* record refusal outside */
      }
      observations.push({
        current,
        scope: observation.scope,
        pending: observation.snapshot.map((entry) => entry.pendingRunId),
      });
    });
    const invalidations = vi.spyOn(cache, 'invalidateQueries');
    jobs.clear();
    lastSync = '2026-02-01';
    clock = 21_001;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await waitFor(() => expect(credentialGets()).toHaveLength(3));
    await waitFor(() =>
      expect(
        cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(key(scope))?.credentials[0]
          ?.pendingRunId,
      ).toBeNull(),
    );
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
    expect(invalidations.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      roots.map((root) => key(scope, [root])),
    );
    expect(observations).toEqual([{ current: true, scope, pending: [null, null] }]);
    expect(new Headers(credentialGets()[2]!.init?.headers).get('Authorization')).toBe('Bearer ' + fresh.token);
    expect(sdkPackets).toHaveLength(1);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(sync.haptics).toEqual(['light']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(credentialGets()).toHaveLength(3);
    expect(invalidations).toHaveBeenCalledTimes(22);
    expect(observations).toHaveLength(1);
    expect(sdkPackets).toHaveLength(1);
    release();
  });
  it('a current offline-paused original refresh resumes once without resending the accepted command', async () => {
    const view = await loaded();
    const before = credentialGets().length;
    sdkReply = async (board) => {
      jobs.set('A:' + board, 'current-offline');
      onlineManager.setOnline(false);
      return Response.json({
        data: { requestProviderSync: { runId: 'current-offline', status: 'queued', coalesced: false } },
      });
    };
    fireEvent.click(syncButtons(view.container)[0]!);
    await waitFor(() =>
      expect(cache.getQueryState(key(runtime.rest.captureRestReadView().scope))?.fetchStatus).toBe('paused'),
    );
    expect(credentialGets()).toHaveLength(before);
    await act(async () => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => expect(credentialGets()).toHaveLength(before + 1));
    await waitFor(() =>
      expect(
        cache.getQueryData<{ credentials: { pendingRunId: string | null }[] }>(
          key(runtime.rest.captureRestReadView().scope),
        )?.credentials[0]?.pendingRunId,
      ).toBe('current-offline'),
    );
    expect(sdkPackets).toHaveLength(1);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
});
