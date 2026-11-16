// @vitest-environment jsdom
import { createElement, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
  useTheme: () => ({
    variant: 'material',
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
  }),
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
  createRestOperation: (...args: Parameters<typeof import('../../../lib/rest-operation.web').createRestOperation>) =>
    runtime.rest.createRestOperation(...args),
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
  clock = 0;
  serial = 0;
  packets = [];
  leases = new Map();
  sessionReply = undefined;
  reply = async () =>
    packets.at(-1)?.url.endsWith('/unsynced')
      ? Response.json({ counts: { tension: { ascents: 7, climbs: 4 } } })
      : Response.json({ credentials: [credential(state.user)] });
  deleteReply = async () => Response.json({ success: true });
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
      if (url.endsWith('/graphql')) return Response.json({ data: { profile: { createdAt: '2020-01-01T00:00:00Z' } } });
      if (!url.startsWith('https://backend.owned.test/api/aurora-credentials'))
        throw new Error('Unexpected owned destination');
      packets.push({ url, init: init ? { ...init, headers: new Headers(init.headers) } : undefined });
      return init?.method === 'DELETE' ? deleteReply() : reply();
    }),
  );
  const store = await import('../../../lib/auth-store.web');
  const rest = await import('../../../lib/rest-operation.web');
  runtime = {
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
function key(scope: string | undefined, logical: readonly unknown[] = ['auroraCredentials']) {
  return [...runtime.clients.browserHttpClients.queryKey([], scope), ...logical];
}
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('../../../components/navigation/TabBarHideFollower', () => ({
  TabBarHideFollower: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticError: vi.fn() }));
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
    Button: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => {
      if (typeof children === 'string') mocks.paperButtonActions.set(children, onPress);
      return createElement('button', { onClick: onPress }, children);
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
function App() {
  return createElement(
    QueryClientProvider,
    { client: cache },
    createElement(
      runtime.toast.ToastProvider,
      null,
      createElement(runtime.dialog.DialogProvider, null, createElement(runtime.section.BoardAccountsSection)),
    ),
  );
}
function unlinkButton(container: HTMLElement) {
  return container.querySelector('[data-button="aurora.card.unlink"]')!;
}
function confirmButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[role="dialog"] button')).find(
    (button) => button.textContent === 'aurora.card.unlink',
  )!;
}
function deletes() {
  return packets.filter((packet) => packet.init?.method === 'DELETE');
}
async function loaded() {
  const view = render(createElement(App));
  await waitFor(() => expect(view.container.textContent).toContain('private-A'));
  return view;
}

let harness: { remove: () => void; retained: () => Promise<void>; pending?: Promise<void>; removing?: () => boolean };
let gap: {
  confirmCalls: number;
  passive: boolean;
  passiveAtLayout: boolean | undefined;
  signalAtLayout: boolean | undefined;
  mode: 'retained' | 'response';
  bodyCancels: number;
};
function HarnessChild() {
  const confirm = runtime.dialog.useConfirm();
  const action = runtime.hook.useUnlinkBoardAccount({
    confirm: async () => {
      gap.confirmCalls++;
      const confirmed = await confirm({
        title: 'unlink',
        message: 'confirm',
        confirmLabel: 'confirm-unlink',
        cancelLabel: 'cancel-unlink',
        destructive: true,
      });
      mocks.confirmationResults.push(confirmed);
      return confirmed;
    },
    successMessage: () => 'unlink-current',
    errorMessage: () => 'unlink-error',
  });
  useLayoutEffect(() => {
    harness.retained = () => action.unlink('tension');
    harness.removing = () => action.isRemoving('tension');
  });
  useEffect(
    () => () => {
      gap.passive = true;
    },
    [],
  );
  return createElement(
    'button',
    {
      'data-harness': true,
      onClick: () => {
        harness.pending = action.unlink('tension');
      },
    },
    'start',
  );
}
let resolveGapResponse: (response: Response) => void;
function HarnessParent() {
  const [active, setActive] = useState(true);
  useLayoutEffect(() => {
    harness.remove = () => setActive(false);
    if (!active) {
      gap.passiveAtLayout = gap.passive;
      gap.signalAtLayout = deletes()[0]?.init?.signal?.aborted;
      if (gap.mode === 'retained') harness.pending = harness.retained();
      else
        resolveGapResponse(
          new Response(
            new ReadableStream({
              cancel() {
                gap.bodyCancels++;
              },
            }),
          ),
        );
    }
  }, [active]);
  return active ? createElement(HarnessChild) : null;
}
function GapApp() {
  return createElement(
    QueryClientProvider,
    { client: cache },
    createElement(
      runtime.toast.ToastProvider,
      null,
      createElement(runtime.dialog.DialogProvider, null, createElement(HarnessParent)),
    ),
  );
}

describe('actual BoardAccounts unlink ownership', () => {
  it('actual dialog cancel sends zero commands and leaves the actual current card', async () => {
    const view = await loaded();
    fireEvent.click(unlinkButton(view.container));
    await waitFor(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    fireEvent.click(
      Array.from(view.container.querySelectorAll('[role="dialog"] button')).find(
        (button) => button.textContent === 'actions.cancel',
      )!,
    );
    await act(async () => {});
    expect(deletes()).toHaveLength(0);
    expect(view.container.textContent).toContain('private-A');
  });
  it.each([200, 207])(
    'actual confirm HTTP%s invalidates exactly the original namespace and current card',
    async (status) => {
      deleteReply = async () =>
        Response.json(
          status === 207 ? { success: false, localCleared: true, reason: 'revocation_failed' } : { success: true },
          { status },
        );
      const view = await loaded();
      const scope = runtime.clients.browserHttpClients.captureRequestView();
      const raw = cache
        .getQueryCache()
        .build(cache, { queryKey: ['auroraCredentials'], queryFn: async () => ({ credentials: [credential('raw')] }) });
      raw.setData({ credentials: [credential('raw')] });
      const otherKey = ['browser-view', 'other', 'auroraCredentials'];
      cache.setQueryData(otherKey, { credentials: [credential('other')] });
      const invalidate = vi.spyOn(cache, 'invalidateQueries');
      fireEvent.click(unlinkButton(view.container));
      await waitFor(() => expect(confirmButton(view.container)).toBeTruthy());
      fireEvent.click(confirmButton(view.container));
      await waitFor(() =>
        expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
          status === 207 ? 'aurora.mobile.unlinkPartial' : 'aurora.mobile.unlinkSuccess',
        ),
      );
      expect(deletes()).toHaveLength(1);
      expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
        key(scope),
        key(scope, ['auroraCredentials', 'unsynced']),
      ]);
      expect(raw.state.isInvalidated).toBe(false);
      expect(cache.getQueryState(otherKey)?.isInvalidated).toBe(false);
      expect(view.container.textContent).toContain('private-A');
    },
  );
  it.each(['version', 'generation', 'SID'])(
    'actual held confirmation refuses same-user %s replacement before HTTP',
    async (kind) => {
      const view = await loaded();
      fireEvent.click(unlinkButton(view.container));
      await waitFor(() => expect(confirmButton(view.container)).toBeTruthy());
      await act(async () => {
        await change(kind);
      });
      fireEvent.click(confirmButton(view.container));
      await act(async () => {});
      expect(deletes()).toHaveLength(0);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it('actual component unmount during confirmation refuses old delivered confirmation', async () => {
    harness = { remove: () => {}, retained: async () => {} };
    gap = {
      confirmCalls: 0,
      passive: false,
      passiveAtLayout: undefined,
      signalAtLayout: undefined,
      mode: 'retained',
      bodyCancels: 0,
    };
    const invalidated = vi.spyOn(cache, 'invalidateQueries');
    const view = render(createElement(GapApp));
    let settled = false;
    let failure: unknown;
    let pending!: Promise<void>;
    await act(async () => {
      pending = harness.retained().then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          failure = error;
          settled = true;
        },
      );
    });
    await waitFor(() => expect(mocks.paperButtonActions.get('confirm-unlink')).toBeTypeOf('function'));
    const deliverActualConfirmation = mocks.paperButtonActions.get('confirm-unlink')!;
    expect(gap.confirmCalls).toBe(1);
    expect(mocks.confirmationResults).toEqual([]);
    expect(settled).toBe(false);
    view.unmount();
    await act(async () => {
      // Calls the captured Paper Button prop, which executes the REAL
      // DialogProvider settle. No detached DOM event or fabricated result.
      deliverActualConfirmation();
      await pending;
    });
    expect(mocks.confirmationResults).toEqual([true]);
    expect(settled).toBe(true);
    expect(failure).toBeUndefined();
    expect(deletes()).toHaveLength(0);
    expect(invalidated).not.toHaveBeenCalled();
  });
  it('original HTTP error maps current feedback but never invalidates success roots', async () => {
    deleteReply = async () => Response.json({ error: 'private-error-payload' }, { status: 429 });
    const view = await loaded();
    const invalidated = vi.spyOn(cache, 'invalidateQueries');
    fireEvent.click(unlinkButton(view.container));
    await waitFor(() => expect(confirmButton(view.container)).toBeTruthy());
    fireEvent.click(confirmButton(view.container));
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('aurora.mobile.rateLimited'),
    );
    expect(view.container.textContent).not.toContain('private-error-payload');
    expect(deletes()).toHaveLength(1);
    expect(invalidated).not.toHaveBeenCalled();
  });
  it('a stale held DELETE cannot consume actual fresh B network or warm B cached rows', async () => {
    const held = deferred<Response>();
    deleteReply = () => held.promise;
    const view = await loaded();
    const scopeA = runtime.clients.browserHttpClients.captureRequestView();
    fireEvent.click(unlinkButton(view.container));
    await waitFor(() => expect(confirmButton(view.container)).toBeTruthy());
    fireEvent.click(confirmButton(view.container));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    await act(async () => {
      await change('B');
    });
    await waitFor(() => expect(view.container.textContent).toContain('private-B'));
    const scopeB = runtime.clients.browserHttpClients.captureRequestView();
    expect(scopeB).not.toBe(scopeA);
    const acceptedB = cache.getQueryData(key(scopeB));
    expect(acceptedB).toEqual({ credentials: [credential('B')] });
    const before = packets.length;
    await act(async () => {
      held.resolve(Response.json({ success: true }));
    });
    await act(async () => {});
    expect(view.container.textContent).toContain('private-B');
    expect(view.container.textContent).not.toContain('private-A');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    view.rerender(createElement(App));
    expect(cache.getQueryData(key(scopeB))).toBe(acceptedB);
    expect(packets).toHaveLength(before);
    expect(deletes()).toHaveLength(1);
  });
  it('actual deletion vetoes retained old action before ancestor layout and passive cleanup', async () => {
    harness = { remove: () => {}, retained: async () => {} };
    gap = {
      confirmCalls: 0,
      passive: false,
      passiveAtLayout: undefined,
      signalAtLayout: undefined,
      mode: 'retained',
      bodyCancels: 0,
    };
    const view = render(createElement(GapApp));
    act(() => {
      harness.remove();
    });
    expect(gap.passiveAtLayout).toBe(false);
    expect(gap.confirmCalls).toBe(0);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(deletes()).toHaveLength(0);
    await act(async () => {
      await harness.pending;
    });
  });
  it('actual deletion retires held physical response before ancestor layout resumes it', async () => {
    const aborts = vi.spyOn(AbortController.prototype, 'abort');
    harness = { remove: () => {}, retained: async () => {} };
    gap = {
      confirmCalls: 0,
      passive: false,
      passiveAtLayout: undefined,
      signalAtLayout: undefined,
      mode: 'response',
      bodyCancels: 0,
    };
    const held = deferred<Response>();
    deleteReply = () => held.promise;
    resolveGapResponse = held.resolve;
    const view = render(createElement(GapApp));
    fireEvent.click(view.container.querySelector('[data-harness]')!);
    await waitFor(() => expect(view.container.querySelector('[role="dialog"]')).not.toBeNull());
    fireEvent.click(
      Array.from(view.container.querySelectorAll('[role="dialog"] button')).find(
        (button) => button.textContent === 'confirm-unlink',
      )!,
    );
    await waitFor(() => expect(deletes()).toHaveLength(1));
    act(() => {
      harness.remove();
    });
    expect(gap.passiveAtLayout).toBe(false);
    expect(gap.signalAtLayout).toBe(true);
    await act(async () => {
      await harness.pending;
    });
    expect(gap.bodyCancels).toBe(1);
    expect(
      aborts.mock.contexts.filter(
        (controller) => controller instanceof AbortController && controller.signal === deletes()[0]?.init?.signal,
      ),
    ).toHaveLength(1);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(deletes()).toHaveLength(1);
    expect(gap.confirmCalls).toBe(1);
  });
});

it('same-board overlapping actual confirmations retain the newer pending invocation', async () => {
  harness = { remove: () => {}, retained: async () => {} };
  gap = {
    confirmCalls: 0,
    passive: false,
    passiveAtLayout: undefined,
    signalAtLayout: undefined,
    mode: 'retained',
    bodyCancels: 0,
  };
  const first = deferred<Response>();
  const second = deferred<Response>();
  deleteReply = () => (deletes().length === 1 ? first.promise : second.promise);
  const view = render(createElement(GapApp));
  let firstPending!: Promise<void>;
  let secondPending!: Promise<void>;
  await act(async () => {
    firstPending = harness.retained();
    secondPending = harness.retained();
  });
  const confirm = () =>
    Array.from(view.container.querySelectorAll('[role="dialog"] button')).find(
      (button) => button.textContent === 'confirm-unlink',
    )!;
  fireEvent.click(confirm());
  await waitFor(() => expect(deletes()).toHaveLength(1));
  fireEvent.click(confirm());
  await waitFor(() => expect(deletes()).toHaveLength(2));
  expect(harness.removing?.()).toBe(true);
  await act(async () => {
    first.resolve(Response.json({ success: true }));
    await firstPending;
  });
  expect(harness.removing?.()).toBe(true);
  await act(async () => {
    second.resolve(Response.json({ success: true }));
    await secondPending;
  });
  expect(harness.removing?.()).toBe(false);
  expect(deletes()).toHaveLength(2);
  expect(gap.confirmCalls).toBe(2);
});
it('unknown transport failure exposes only fixed current feedback and no cache effects', async () => {
  const view = await loaded();
  deleteReply = async () => {
    throw new Error('private network diagnostic');
  };
  const invalidated = vi.spyOn(cache, 'invalidateQueries');
  fireEvent.click(unlinkButton(view.container));
  await waitFor(() => expect(confirmButton(view.container)).toBeTruthy());
  fireEvent.click(confirmButton(view.container));
  await waitFor(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('aurora.mobile.requestFailed'),
  );
  expect(view.container.textContent).not.toContain('private network diagnostic');
  expect(invalidated).not.toHaveBeenCalled();
  expect(deletes()).toHaveLength(1);
});
it('first actual invalidation retirement observes rejection and refuses every later old effect', async () => {
  const view = await loaded();
  const actual = cache.invalidateQueries.bind(cache);
  const observed = vi.spyOn(cache, 'invalidateQueries').mockImplementation((...args) => {
    const pending = actual(...args);
    void runtime.store.clearTokens();
    return pending.then(() => {
      throw new Error('private invalidation diagnostic');
    });
  });
  fireEvent.click(unlinkButton(view.container));
  await waitFor(() => expect(confirmButton(view.container)).toBeTruthy());
  fireEvent.click(confirmButton(view.container));
  await waitFor(() => expect(deletes()).toHaveLength(1));
  await act(async () => {});
  expect(observed).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.textContent).not.toContain('private invalidation diagnostic');
});
// Real AuthProvider ownership boundary; mocks above are platform/storage effects, not HTTP acceptance.
vi.mock('../../../notifications/device-registration', () => ({
  deactivateNotificationDevice: async () => {
    authFixture.cleanupCalls++;
    await authFixture.cleanupGate;
  },
}));
vi.mock('../../../lib/profiling/startup-profile', () => ({ markStartup: vi.fn(async () => undefined) }));
vi.mock('../../../lib/consent-state', () => ({ invalidateConsentAccount: vi.fn(async () => undefined) }));
vi.mock('../../../lib/verified-auth-result', () => ({ commitVerifiedAuthResult: vi.fn(async () => undefined) }));
vi.mock('../../../lib/signup-conversion', () => ({ publishSignupConversion: vi.fn(async () => undefined) }));
vi.mock('../../../lib/auth-analytics-handoff', () => ({
  cancelAuthAnalyticsHandoffs: vi.fn(async () => undefined),
  createAuthAnalyticsHandoff: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/login-analytics', () => ({ trackLoginSucceeded: vi.fn(async () => undefined) }));
vi.mock('../../../lib/account-deletion-intent', () => ({
  isAccountDeletionIntentCurrent: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/auth-transport-revision', () => ({ bumpAuthTransportRevision: vi.fn(async () => undefined) }));
vi.mock('../../../lib/auth', () => ({
  signInWithApple: vi.fn(async () => undefined),
  signInWithGoogle: vi.fn(async () => undefined),
  signInWithGoogleWeb: vi.fn(async () => undefined),
  signInWithAppleWeb: vi.fn(async () => undefined),
  signOutForGeneration: vi.fn(async () => undefined),
  signInWithCredentials: vi.fn(async () => undefined),
  registerWithCredentials: vi.fn(async () => undefined),
}));
vi.mock('../../../offline/offline-usage-signal', () => ({ resetOfflineUsageSignal: vi.fn(async () => undefined) }));
vi.mock('../../../lib/relay-receipt', () => ({ clearRelayReceipt: vi.fn(async () => undefined) }));
vi.mock('../../../lib/ble/remembered-boards-sign-out', () => ({
  forgetRememberedBoardsOnSignOut: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/graphql/ws-client', () => ({ disposeWsClient: vi.fn(async () => undefined) }));
vi.mock('../../../lib/session-store', () => ({ clearStoredSessionId: vi.fn(async () => undefined) }));
vi.mock('../../../lib/user-data-export-download', () => ({
  clearUserDataExportDownloads: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/queue-snapshot-store', () => ({ clearStoredQueueSnapshot: vi.fn(async () => undefined) }));
vi.mock('../../../lib/onboarding/first-board-picker-store', () => ({
  clearFirstBoardPickerShowCount: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/create-climb-draft-store', () => ({ clearAllCreateClimbDrafts: vi.fn(async () => undefined) }));
vi.mock('../../../lib/session-comment-draft-store', () => ({ clearSessionCommentDraft: vi.fn(async () => undefined) }));
vi.mock('../../../lib/workout-run-store', () => ({ clearWorkoutRun: vi.fn(async () => undefined) }));
vi.mock('../../../lib/ended-workout-store', () => ({ clearEndedWorkouts: vi.fn(async () => undefined) }));
vi.mock('../../../lib/spray/spray-wall-led-cache', () => ({
  eraseAllSprayWallLedCaches: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/boards/active-board-self-heal-validation-cache', () => ({
  resetActiveBoardSelfHealValidationCache: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  clearLinkEmptyPromptDismissal: vi.fn(async () => undefined),
  resumeLinkEmptyDismissalWrites: vi.fn(async () => undefined),
  suspendLinkEmptyDismissalWrites: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/spray/spray-photo-store', () => ({ clearStoredSprayPhotos: vi.fn(async () => undefined) }));
vi.mock('../../../lib/spray/spray-privacy-cleanup', () => ({
  clearSprayWallPrivateCaches: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({
  dropSprayWallViewerAccess: vi.fn(async () => undefined),
  refreshSprayWallViewerAccess: vi.fn(async () => undefined),
}));
vi.mock('../../../offline/account-boundary', () => ({ resetOfflineAccountSettings: vi.fn(async () => undefined) }));
vi.mock('../../../settings', () => ({
  clearSprayWallArchives: vi.fn(async () => undefined),
  clearOwnedSprayWallPins: vi.fn(async () => undefined),
}));
vi.mock('../../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: vi.fn(async () => undefined),
  reportScopeDownloadAbandonedOnSignOut: vi.fn(async () => undefined),
}));
vi.mock('../../../offline/abandoned-download-terminals', () => ({
  reportAbandonedDownloadsOnSignOut: vi.fn(async () => undefined),
}));
vi.mock('../../../offline/outbox-telemetry', () => ({ reportOutboxDiscardedOnSignOut: vi.fn(async () => undefined) }));
vi.mock('../../../notifications', () => ({ stopTokenManagement: vi.fn(async () => undefined) }));
vi.mock('../../../lib/oauth-pending-store', () => ({ consumeFreshOAuthPending: vi.fn(async () => undefined) }));
vi.mock('../../../lib/oauth-return', () => ({ consumeWebOAuthReturn: () => null }));

vi.mock('expo-router', () => ({
  useSegments: () => [],
  Redirect: ({ href }: { href: string }) => createElement('p', { 'data-redirect': href }, href),
}));
vi.mock('../../../components/AppLoadingSplash', () => ({
  AppLoadingSplash: () => {
    authFixture.splash++;
    return createElement('p', { 'data-auth-splash': true }, 'loading-account');
  },
}));
vi.mock('../../../lib/auth-session', () => ({ resolveAuthSession: () => runtime.store.synchronizeWebSession() }));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => runtime.store.captureAuthCredentialGeneration(),
  getAuthToken: () => runtime.store.getAuthToken(),
  isAuthCredentialGenerationCurrent: (generation: number) =>
    runtime.store.isAuthCredentialGenerationCurrent(generation),
}));
vi.mock('../../../lib/auth-token-events', () => ({
  subscribeAuthTokenChanges: (
    ...args: Parameters<typeof import('../../../lib/auth-store.web').subscribeAuthTokenChanges>
  ) => runtime.store.subscribeAuthTokenChanges(...args),
}));
vi.mock('../../../lib/analytics', () => ({
  getAnalyticsIdentity: () => null,
  isAnalyticsPinnedToAPerson: () => false,
  reset: vi.fn(),
  track: vi.fn(),
  capture: vi.fn(),
  setPersonProperties: vi.fn(),
}));
vi.mock('../../../lib/consent-bound-analytics', () => ({ createConsentBoundAnalyticsRunner: () => () => {} }));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => runtime.clients.getHttpClient(),
  resetHttpClient: () => runtime.clients.resetHttpClient(),
}));
vi.mock('../../../lib/user-storage-owner', () => ({
  setCurrentUserStorageOwner: vi.fn(),
  getCurrentUserStorageOwner: () => null,
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  ACTIVE_BOARD_QUERY_KEY: ['activeBoard'],
  clearStoredActiveBoardCoordinated: vi.fn(async () => {}),
}));
vi.mock('../../../lib/app-entry-route', () => ({ getAppEntryHref: () => '/app' }));
vi.mock('../../../db', () => ({
  clearUserData: vi.fn(async () => {}),
  purgeLocalDataForSignOut: vi.fn(async () => ({
    pendingDiscarded: 0,
    deadLettersDiscarded: 0,
    hadDownloads: false,
    vacuumed: true,
  })),
  getDatabaseHandle: () => null,
}));
vi.mock('../../../hooks/use-current-user-id', () => ({ STORED_USER_ID_QUERY_KEY: ['storedUserId'] }));
vi.mock('@boardsesh/offline-sync', () => ({
  getOutboxSummary: async () => ({
    pendingCount: 0,
    deadLetterCount: 0,
    oldestPendingAt: null,
    oldestDeadLetterAt: null,
  }),
  setSigningOut: vi.fn(),
}));
vi.mock('../../../lib/routing/anonymous-auth-gate', () => ({
  isAnonymousReadOnlyLocation: () => false,
  readPostLoginReturnHref: () => null,
}));

function AppWithRealAuth() {
  return createElement(
    QueryClientProvider,
    { client: cache },
    createElement(
      runtime.authProvider.AuthProvider,
      null,
      createElement(
        runtime.toast.ToastProvider,
        null,
        createElement(runtime.dialog.DialogProvider, null, createElement(runtime.section.BoardAccountsSection)),
      ),
    ),
  );
}
it('real AuthProvider hides and unmounts A while actual UID/SID cleanup awaits before B', async () => {
  runtime.authProvider = await vi.importActual<typeof import('../../../providers/auth-provider')>(
    '../../../providers/auth-provider',
  );
  authFixture.actual = true;
  const view = render(createElement(AppWithRealAuth));
  await waitFor(() => expect(view.container.textContent).toContain('private-A'));
  const heldDelete = deferred<Response>();
  deleteReply = () => heldDelete.promise;
  fireEvent.click(unlinkButton(view.container));
  await waitFor(() => expect(confirmButton(view.container)).toBeTruthy());
  fireEvent.click(confirmButton(view.container));
  await waitFor(() => expect(deletes()).toHaveLength(1));
  const cleanupGate = deferred<void>();
  authFixture.cleanupGate = cleanupGate.promise;
  await act(async () => {
    await change('B');
  });
  await waitFor(() => expect(view.container.querySelector('[data-auth-splash]')).not.toBeNull());
  expect(authFixture.cleanupCalls).toBeGreaterThan(0);
  expect(view.container.textContent).not.toContain('private-A');
  expect(deletes()[0]?.init?.signal?.aborted).toBe(true);
  await act(async () => {
    heldDelete.resolve(Response.json({ success: true }));
    cleanupGate.resolve();
  });
  await waitFor(() => expect(view.container.textContent).toContain('private-B'));
  expect(view.container.textContent).not.toContain('private-A');
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(deletes()).toHaveLength(1);
});
