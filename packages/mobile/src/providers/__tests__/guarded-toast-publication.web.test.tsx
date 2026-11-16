// @vitest-environment jsdom
import {
  createElement,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  Suspense,
  StrictMode,
  type ReactNode,
} from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
const state = vi.hoisted(() => ({
  native: false,
  required: true,
  legacy: false,
  anonymous: false,
  unavailable: false,
  user: 'A',
  sid: 'login-A',
  version: 2,
  generation: 1,
}));
vi.mock('../../lib/browser-consumer-readiness.web', () => ({ publicExpoBrowserConsumersReady: () => state.required }));
vi.mock('../../lib/browser-coordinator-client.web', () => ({ coordinateExpoBrowserSession: vi.fn(async () => {}) }));
const native = vi.hoisted(() => ({
  token: 'native-old',
  generation: 7,
  expiring: false,
  offline: false,
  signouts: [] as number[],
}));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => native.generation,
  getAuthToken: async () => native.token,
  getRefreshToken: async () => 'native-refresh',
  isAuthCredentialGenerationCurrent: (generation: number) => generation === native.generation,
  storeTokensForGeneration: async (generation: number, token: string) => {
    if (generation !== native.generation) return false;
    native.token = token;
    return true;
  },
  isTokenExpiringSoon: async () => native.expiring,
  getTokenExpiresAt: async () => null,
}));
vi.mock('../../lib/auth', () => ({
  signOutForGeneration: async (generation: number) => {
    native.signouts.push(generation);
    return true;
  },
}));
vi.mock('../../lib/client-identity', () => ({
  getClientIdentityHeaderValue: () => 'native-owned',
  clientIdentityHeaders: () => ({ 'x-boardsesh-client': 'native-owned' }),
}));
vi.mock('../../lib/auth-interceptor', () => ({
  authenticatedFetch: (...args: Parameters<typeof import('../../lib/auth-interceptor.web').authenticatedFetch>) =>
    (state.native ? runtime.nativeInterceptor : runtime.interceptor).authenticatedFetch(...args),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../lib/env', () => ({
  BACKEND_URL: 'https://backend.owned.test/',
  WEB_BASE_URL: 'https://www.owned.test',
  webApiUrl: (path: string) => 'https://www.owned.test' + path,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'rest-owned' } } }));
vi.mock('../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: native.offline }),
  reportBackendOutcome: vi.fn(),
}));
let runtime: {
  toast: typeof import('../toast-provider');
  hook: typeof import('../../lib/integrations/use-unlink-board-account');
  nativeRest: typeof import('../../lib/rest-operation');
  nativeInterceptor: typeof import('../../lib/auth-interceptor');
  aurora: typeof import('../../lib/aurora-credentials');
  store: typeof import('../../lib/auth-store.web');
  rest: typeof import('../../lib/rest-operation.web');
  backend: typeof import('../../lib/browser-backend-client.web');
  clients: typeof import('../../lib/graphql/client.web');
  interceptor: typeof import('../../lib/auth-interceptor.web');
  admission: typeof import('../../lib/browser-response-admission.web');
};
let clock: number;
let serial: number;
let packets: { url: string; init?: RequestInit }[];
let leases: Map<string, BrowserBackendLeaseOwner>;
let reply: () => Promise<Response>;
let sessionReply: (() => Promise<Response>) | undefined;
let nativeRefresh: (() => Promise<Response>) | undefined;

let leaseReply: ((response: Response) => Promise<Response>) | undefined;
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
  if (
    /^(same-owner(?:401| )|own401|unavailable401|restrictive original|veto before retry|a same-generation)/.test(
      context.task.name,
    )
  ) {
    state.required = false;
    state.legacy = true;
  }
  state.native = context.task.name.startsWith('native ');
  Object.assign(native, { token: 'native-old', generation: 7, expiring: false, offline: false, signouts: [] });
  nativeRefresh = undefined;
  ui.variant = 'material';
  ui.revision = 0;
  ui.suspend = false;
  ui.gate = undefined;
  ui.attempted = [];
  ui.haptics = [];
  ui.announcements = [];
  clock = 0;
  serial = 0;
  packets = [];
  leases = new Map();
  sessionReply = undefined;
  leaseReply = undefined;
  reply = async () => Response.json({ success: true });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/auth/native/refresh')) {
        return nativeRefresh
          ? nativeRefresh()
          : Response.json({ jwt: 'native-new', refreshToken: 'new-refresh', expiresAt: '2099-01-01T00:00:00Z' });
      }
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
        const response = Response.json({ status: 'admitted', token, usableForMs: 120000, owner: owner() });
        return leaseReply ? leaseReply(response) : response;
      }
      if (url.endsWith('/api/auth/csrf')) return Response.json({ csrfToken: 'owned-csrf' });
      if (url.endsWith('/api/auth/signout')) return Response.json({ url: '/app' });
      if (!url.startsWith('https://backend.owned.test/api/aurora-credentials'))
        throw new Error('Unexpected owned destination');
      packets.push({ url, init: init ? { ...init, headers: new Headers(init.headers) } : undefined });
      return reply();
    }),
  );
  const store = await import('../../lib/auth-store.web');
  const rest = await import('../../lib/rest-operation.web');
  runtime = {
    toast: await import('../toast-provider'),
    hook: await import('../../lib/integrations/use-unlink-board-account'),
    nativeRest: await import('../../lib/rest-operation'),
    nativeInterceptor: await vi.importActual<typeof import('../../lib/auth-interceptor')>('../../lib/auth-interceptor'),
    aurora: await import('../../lib/aurora-credentials'),
    store,
    rest,
    backend: await import('../../lib/browser-backend-client.web'),
    clients: await import('../../lib/graphql/client.web'),
    interceptor: await import('../../lib/auth-interceptor.web'),
    admission: await import('../../lib/browser-response-admission.web'),
  };
  await admit();
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000 } } });
});
afterEach(() => {
  cleanup();
  cache?.clear();
  ui.listeners.clear();
  vi.useRealTimers();
  runtime?.clients.browserHttpClients.dispose();
  runtime?.backend.expoBrowserBackendClient.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ui = vi.hoisted(() => ({
  variant: 'material' as 'material' | 'liquidGlass',
  revision: 0,
  listeners: new Set<() => void>(),
  suspend: false,
  gate: undefined as { promise: Promise<void>; resolve: () => void } | undefined,
  attempted: [] as string[],
  haptics: [] as string[],
  announcements: [] as string[],
}));
vi.mock('../../lib/rest-operation', () => ({
  createRestOperation: (...args: Parameters<typeof import('../../lib/rest-operation.web').createRestOperation>) =>
    runtime.rest.createRestOperation(...args),
  createUnlinkRestOperation: (
    ...args: Parameters<typeof import('../../lib/rest-operation.web').createUnlinkRestOperation>
  ) => runtime.rest.createUnlinkRestOperation(...args),
  captureRestReadView: () => runtime.rest.captureRestReadView(),
  useRestView: () => runtime.rest.useRestView(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({
    children,
    accessibilityRole,
    accessibilityLiveRegion,
    ...props
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLiveRegion?: string;
  }) => createElement('div', { role: accessibilityRole, 'aria-live': accessibilityLiveRegion, ...props }, children),
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
  AccessibilityInfo: { announceForAccessibilityWithOptions: (message: string) => ui.announcements.push(message) },
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({
      children,
      accessibilityRole,
      accessibilityLiveRegion,
    }: {
      children?: ReactNode;
      accessibilityRole?: string;
      accessibilityLiveRegion?: string;
    }) => createElement('div', { role: accessibilityRole, 'aria-live': accessibilityLiveRegion }, children),
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('../../components/navigation/TabBarHideFollower', () => ({
  TabBarHideFollower: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../components/Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => {
    if (typeof children === 'string' && children.startsWith('guarded-')) {
      ui.attempted.push(children);
      if (ui.suspend && ui.gate) throw ui.gate.promise;
    }
    return createElement('span', null, children);
  },
}));
vi.mock('../theme-provider', () => ({
  useTheme: () => {
    useSyncExternalStore(
      (listener) => {
        ui.listeners.add(listener);
        return () => ui.listeners.delete(listener);
      },
      () => ui.revision,
      () => 0,
    );
    return {
      variant: ui.variant,
      colorScheme: 'light',
      systemColors: { secondaryBackground: '#fff', label: '#000' },
      brandColors: { primary: '#123', success: '#456', error: '#789', warning: '#abc' },
    };
  },
}));
vi.mock('../../lib/haptics', () => ({
  hapticSuccess: () => ui.haptics.push('success'),
  hapticError: () => ui.haptics.push('error'),
}));
vi.mock('react-native-paper', () => ({
  Snackbar: ({
    children,
    visible,
    onDismiss,
    duration,
  }: {
    children?: ReactNode;
    visible: boolean;
    onDismiss: () => void;
    duration: number;
  }) => {
    useEffect(() => {
      if (!visible) return;
      const timer = setTimeout(onDismiss, duration);
      return () => clearTimeout(timer);
    }, [visible, onDismiss, duration]);
    return visible
      ? createElement(
          'section',
          { 'data-snackbar': 'true' },
          children,
          createElement('button', { 'data-dismiss': 'true', onClick: onDismiss }, 'dismiss'),
        )
      : null;
  },
}));
let cache: QueryClient;
let controls: { unlink: () => Promise<void>; plain: (message: string) => void; removing: () => boolean };
function Launcher({ message = 'guarded-current' }: { message?: string }) {
  const action = runtime.hook.useUnlinkBoardAccount({
    confirm: async () => true,
    successMessage: () => message,
    errorMessage: () => message + '-error',
  });
  const toast = runtime.toast.useToast();
  useLayoutEffect(() => {
    controls = {
      unlink: () => action.unlink('kilter'),
      plain: (text) => toast.showToast(text),
      removing: () => action.isRemoving('kilter'),
    };
  });
  return createElement(
    'button',
    {
      'data-run': 'true',
      onClick: () => {
        void action.unlink('kilter');
      },
    },
    'unlink',
  );
}
function Host({ message = 'guarded-current', strict = false }: { message?: string; strict?: boolean }) {
  const content = createElement(
    QueryClientProvider,
    { client: cache },
    createElement(runtime.toast.ToastProvider, null, createElement(Launcher, { message })),
  );
  return createElement(
    Suspense,
    { fallback: createElement('p', { 'data-fallback': 'true' }, 'held') },
    strict ? createElement(StrictMode, null, content) : content,
  );
}
function observe(container: HTMLElement) {
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
    ui.revision++;
    for (const listener of ui.listeners) listener();
  });
}

describe('actual guarded unlink toast publication', () => {
  it.each(['material', 'liquidGlass'] as const)(
    'actual %s current child publishes once and own timer dismisses',
    async (variant) => {
      ui.variant = variant;
      if (variant === 'liquidGlass') vi.useFakeTimers();
      const view = render(createElement(Host));
      await act(async () => {
        await controls.unlink();
      });
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('guarded-current');
      expect(ui.haptics).toEqual(['success']);
      expect(ui.announcements).toEqual([]);
      expect(packets).toHaveLength(1);
      await themeChange();
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('guarded-current');
      expect(ui.haptics).toEqual(['success']);
      if (variant === 'material') fireEvent.click(view.container.querySelector('[data-dismiss]')!);
      else {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3001);
        });
      }
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it('mixed plain/guarded MAX2 permanently evicts the old plain toast', async () => {
    const view = render(createElement(Host, { message: 'guarded-three' }));
    act(() => {
      controls.plain('plain-one');
    });
    act(() => {
      controls.plain('plain-two');
    });
    await act(async () => {
      await controls.unlink();
    });
    expect(view.container.textContent).not.toContain('plain-one');
    expect(view.container.textContent).toContain('plain-two');
    expect(view.container.textContent).toContain('guarded-three');
    fireEvent.click(Array.from(view.container.querySelectorAll('[data-dismiss]')).at(-1)!);
    expect(view.container.textContent).not.toContain('plain-one');
    expect(view.container.textContent).toContain('plain-two');
    expect(packets).toHaveLength(1);
  });
  it.each(['material', 'liquidGlass'] as const)(
    'actual %s child rerender refuses original E1 while E2 remains live',
    async (variant) => {
      ui.variant = variant;
      const view = render(createElement(Host));
      await act(async () => {
        await controls.unlink();
      });
      expect(view.container.textContent).toContain('guarded-current');
      clock = 110000;
      const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
      const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
      clock = 120001;
      expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
      await themeChange();
      expect(view.container.textContent).not.toContain('guarded-current');
      expect(packets).toHaveLength(1);
    },
  );
  it.each(['B', 'ABA', 'SID', 'version', 'generation'])(
    'old queued message never enters actual DOM after %s retirement',
    async (kind) => {
      const view = render(createElement(Host, { message: 'guarded-retired' }));
      const observed = observe(view.container);
      ui.gate = deferred<void>();
      ui.suspend = true;
      let finished = false;
      let pending!: Promise<void>;
      await act(async () => {
        pending = controls.unlink().then(() => {
          finished = true;
        });
      });
      await waitFor(() => expect(ui.attempted).toContain('guarded-retired'));
      expect(observed.seen.some((text) => text.includes('guarded-retired'))).toBe(false);
      await act(async () => {
        await change(kind);
      });
      ui.suspend = false;
      await act(async () => {
        ui.gate!.resolve();
        await pending;
      });
      expect(observed.seen.some((text) => text.includes('guarded-retired'))).toBe(false);
      expect(view.container.textContent).not.toContain('guarded-retired');
      expect(finished).toBe(true);
      expect(packets).toHaveLength(1);
      observed.stop();
    },
  );
  it('coordinator release preserves a current toast already held before its first commit', async () => {
    const view = render(createElement(Host, { message: 'guarded-held-current' }));
    const observed = observe(view.container);
    ui.gate = deferred<void>();
    ui.suspend = true;
    let settled = false;
    await act(async () => {
      await controls.unlink();
      settled = true;
    });
    await waitFor(() => expect(ui.attempted).toContain('guarded-held-current'));
    expect(settled).toBe(true);
    expect(packets[0]?.init?.signal?.aborted).toBe(false);
    expect(observed.seen.some((text) => text.includes('guarded-held-current'))).toBe(false);
    ui.suspend = false;
    await act(async () => {
      ui.gate!.resolve();
    });
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('guarded-held-current'),
    );
    expect(observed.seen.some((text) => text.includes('guarded-held-current'))).toBe(true);
    expect(packets).toHaveLength(1);
    expect(ui.haptics).toEqual(['success']);
    expect(packets[0]?.init?.signal?.aborted).toBe(false);
    fireEvent.click(view.container.querySelector('[data-dismiss]')!);
    expect(packets[0]?.init?.signal?.aborted).toBe(true);
    observed.stop();
  });
  it('presentation dismissal preserves both already-started current coordinator invalidations', async () => {
    const held = deferred<void>();
    const actual = cache.invalidateQueries.bind(cache);
    let enqueues = 0;
    vi.spyOn(cache, 'invalidateQueries').mockImplementation(async (...args) => {
      enqueues++;
      await actual(...args);
      await held.promise;
    });
    const view = render(createElement(Host));
    let settled = false;
    let pending!: Promise<void>;
    await act(async () => {
      pending = controls.unlink().then(() => {
        settled = true;
      });
    });
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('guarded-current'));
    expect(enqueues).toBe(2);
    expect(packets[0]?.init?.signal?.aborted).toBe(false);
    fireEvent.click(view.container.querySelector('[data-dismiss]')!);
    expect(settled).toBe(false);
    expect(packets[0]?.init?.signal?.aborted).toBe(false);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      held.resolve();
      await pending;
    });
    expect(settled).toBe(true);
    expect(packets[0]?.init?.signal?.aborted).toBe(true);
    expect(packets).toHaveLength(1);
    expect(ui.haptics).toEqual(['success']);
  });
  it('StrictMode simulated cleanup keeps the original current terminal proof', async () => {
    const view = render(createElement(Host, { strict: true }));
    await act(async () => {
      await controls.unlink();
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('guarded-current');
    expect(ui.haptics).toEqual(['success']);
    expect(packets).toHaveLength(1);
    view.unmount();
    await act(async () => {});
  });
  it('original queued E1 never first-commits while independently issued E2 is live', async () => {
    const view = render(createElement(Host, { message: 'guarded-expired' }));
    const observed = observe(view.container);
    ui.gate = deferred<void>();
    ui.suspend = true;
    await act(async () => {
      await controls.unlink();
    });
    await waitFor(() => expect(ui.attempted).toContain('guarded-expired'));
    expect(packets[0]?.init?.signal?.aborted).toBe(false);
    clock = 110000;
    const fresh = await runtime.backend.expoBrowserBackendClient.acquire(owner());
    const scope = runtime.backend.expoBrowserBackendClient.capture(fresh.token)!;
    clock = 120001;
    expect(() => runtime.backend.expoBrowserBackendClient.assertCurrent(scope, fresh)).not.toThrow();
    ui.suspend = false;
    await act(async () => {
      ui.gate!.resolve();
    });
    expect(observed.seen.some((text) => text.includes('guarded-expired'))).toBe(false);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(ui.haptics).toEqual([]);
    expect(packets).toHaveLength(1);
    observed.stop();
  });
  it.each([207, 429])(
    'actual queued HTTP%s outcome cannot first-commit after original owner retirement',
    async (status) => {
      reply = async () =>
        Response.json(
          status === 207
            ? { success: false, localCleared: true, reason: 'revocation_failed' }
            : { error: 'private server detail' },
          { status },
        );
      const view = render(createElement(Host, { message: 'guarded-old-outcome' }));
      const observed = observe(view.container);
      ui.gate = deferred<void>();
      ui.suspend = true;
      await act(async () => {
        await controls.unlink();
      });
      await waitFor(() => expect(ui.attempted.some((text) => text.startsWith('guarded-old-outcome'))).toBe(true));
      await act(async () => {
        await change('B');
      });
      ui.suspend = false;
      await act(async () => {
        ui.gate!.resolve();
      });
      expect(observed.seen.some((text) => text.includes('guarded-old-outcome'))).toBe(false);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(ui.haptics).toEqual([]);
      expect(packets).toHaveLength(1);
      observed.stop();
    },
  );
});
