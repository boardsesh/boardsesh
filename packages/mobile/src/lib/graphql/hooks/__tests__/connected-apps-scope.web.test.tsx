// @vitest-environment jsdom
import { createElement, useState, useSyncExternalStore, StrictMode, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { GraphQLClient } from 'graphql-request';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectedApps } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../http-query-scope';
import type { createScopedHttpFixture } from '../../__tests__/fixtures/scoped-http';
const ports = vi.hoisted(() => ({
  http: null as ReturnType<typeof createScopedHttpFixture> | null,
  scope: null as HttpQueryScope | null,
  native: false,
  nativeClient: null as GraphQLClient | null,
  authenticated: true,
  id: 'app-A',
  push: vi.fn(),
  back: vi.fn(),
  canBack: vi.fn(() => true),
  confirm: vi.fn<() => Promise<boolean>>(),
  success: vi.fn(),
  error: vi.fn(),
  themeRevision: 0,
  themeListeners: new Set<() => void>(),
  callbacks: [] as Array<() => void>,
}));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    if (ports.native && ports.nativeClient) return ports.nativeClient;
    throw new Error('Unexpected native HTTP');
  },
  getOfflineSyncHttpClient: () => {
    throw new Error('Unexpected native offline HTTP');
  },
}));
vi.mock('../../use-http-query-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../use-http-query-scope')>();
  return { ...actual, useHttpQueryScope: () => ports.scope ?? actual.useHttpQueryScope() };
});
vi.mock('../../http-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../http-operation')>();
  return {
    ...actual,
    createHttpOperation: (scope: string | undefined, options?: import('../../http-operation').HttpOperationOptions) => {
      if (ports.native) return actual.createHttpOperation(scope, options);
      if (!ports.http) throw new Error('Missing actual selected factory');
      return ports.http.operations.create(scope, options);
    },
  };
});
// Platform port bound to the owned actual manager/facade, never an accepting guard.
vi.mock('../../use-auth-token', () => ({
  subscribeHttpOperationScope: (listener: () => void) => {
    if (!ports.http) return () => {};
    const releaseManager = ports.http.backend.subscribe(listener);
    const releaseFacade = ports.http.facade.subscribe(listener);
    return () => {
      releaseManager();
      releaseFacade();
    };
  },
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: ports.authenticated }) }));
vi.mock('../../../../providers/dialog-provider', () => ({ useConfirm: () => ports.confirm }));
vi.mock('../../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push: ports.push } }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: ports.id }),
  useRouter: () => ({ back: ports.back, canGoBack: ports.canBack }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    accessibilityRole,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityRole?: string;
  }) => createElement('div', { 'data-testid': testID, role: accessibilityRole }, children),
  ScrollView: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'web' },
  PlatformColor: (color: string) => color,
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => {
    useSyncExternalStore(
      (listener) => {
        ports.themeListeners.add(listener);
        return () => {
          ports.themeListeners.delete(listener);
        };
      },
      () => ports.themeRevision,
    );
    return {
      colorScheme: 'light',
      systemColors: {
        label: '#111',
        secondaryLabel: '#222',
        groupedBackground: '#eee',
        secondaryBackground: '#fff',
        secondaryGroupedBackground: '#fff',
        tertiaryGroupedBackground: '#ddd',
      },
      brandColors: { primary: '#123456', warning: '#234567', success: '#345678', error: '#456789' },
    };
  },
}));
vi.mock('../../../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../components/ActivityIndicator', () => ({ ActivityIndicator: () => <span>loading</span> }));
vi.mock('../../../../components/SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock('../../../../components/ListRow', () => ({
  ListRow: ({ title, onPress, testID }: { title: string; onPress: () => void; testID: string }) => {
    ports.callbacks.push(onPress);
    return (
      <button onClick={onPress} data-testid={testID}>
        {title}
      </button>
    );
  },
}));
vi.mock('../../../../components/Button', () => ({
  Button: ({
    title,
    onPress,
    accessibilityLabel,
    disabled,
    loading,
  }: {
    title: string;
    onPress: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
    loading?: boolean;
  }) => {
    ports.callbacks.push(onPress);
    return (
      <button onClick={onPress} aria-label={accessibilityLabel} disabled={disabled} data-loading={String(!!loading)}>
        {title}
      </button>
    );
  },
}));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSuccess: ports.success, hapticError: ports.error }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, top: 0 }) }));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  FadeIn: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
}));
vi.mock('react-native-paper', () => ({ Snackbar: ({ children }: { children?: ReactNode }) => <div>{children}</div> }));
vi.mock('../../../../components/navigation/TabBarHideFollower', () => ({
  TabBarHideFollower: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../theme/variants', () => ({
  createVariantComponent: (_name: string, variants: Record<string, unknown>) => variants.material,
}));
const { createScopedHttpFixture: makeHttp } = await import('../../__tests__/fixtures/scoped-http');
import { createHttpQueryScope } from '../../http-query-scope';
import { createHttpOperation } from '../../http-operation';
import { __resetConnectivityStoreForTests } from '../../../connectivity/connectivity-store';
import { useMyConnectedApps, useDisconnectApp, CONNECTED_APPS_QUERY_KEY } from '../use-connected-apps';
import { PartnerAppsSection } from '../../../../components/integrations/PartnerAppsSection';
import { ConnectedAppDetailScreen } from '../../../../components/integrations/ConnectedAppDetailScreen';
import { ToastProvider } from '../../../../providers/toast-provider';
const apps: ConnectedApps = {
  partnerAppsEnabled: true,
  apps: [
    {
      connectionId: 'app-A',
      name: 'PRIVATE APP A',
      publisherName: 'Owned publisher',
      scopes: ['logbook:read'],
      connectedAt: '2026-10-01T00:00:00Z',
      lastUsedAt: null,
      suspended: false,
    },
    {
      connectionId: 'app-B',
      name: 'PRIVATE APP B',
      publisherName: null,
      scopes: ['profile:read'],
      connectedAt: '2026-10-01T00:00:00Z',
      lastUsedAt: null,
      suspended: false,
    },
  ],
};
const release: Array<() => void> = [];
afterEach(() => {
  cleanup();
  release
    .splice(0)
    .reverse()
    .forEach((close) => close());
  ports.http = null;
  ports.scope = null;
  ports.native = false;
  ports.nativeClient = null;
  ports.authenticated = true;
  ports.id = 'app-A';
  ports.callbacks.splice(0);
  ports.themeRevision = 0;
  ports.themeListeners.clear();
  vi.clearAllMocks();
  ports.confirm.mockReset();
  ports.canBack.mockReset().mockReturnValue(true);
  ports.back.mockReset();
  vi.useRealTimers();
  __resetConnectivityStoreForTests();
  onlineManager.setOnline(true);
});
function fixture() {
  __resetConnectivityStoreForTests();
  onlineManager.setOnline(true);
  const http = makeHttp();
  ports.http = http;
  const scope = http.scope();
  ports.scope = scope;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  release.push(() => {
    cache.clear();
    http.dispose();
  });
  ports.confirm.mockResolvedValue(true);
  let disconnected = false;
  http.performFetch.mockImplementation(async (_input, init) => {
    const packet = JSON.parse((init as RequestInit).body as string) as { query: string };
    if (packet.query.includes('DisconnectApp')) {
      disconnected = true;
      return Response.json({ data: { disconnectApp: true } });
    }
    return Response.json({
      data: packet.query.includes('viewer')
        ? { viewer: { id: 'owned-A' } }
        : { myConnectedApps: disconnected ? { ...apps, apps: apps.apps.slice(1) } : apps },
    });
  });
  const wrapper = ({ children }: { children?: ReactNode }) => (
    <QueryClientProvider client={cache}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return { ...http, scope, cache, wrapper };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function packet(init: unknown) {
  return JSON.parse((init as RequestInit).body as string) as { query: string; variables?: { connectionId?: string } };
}
function writes(current: ReturnType<typeof fixture>) {
  return current.performFetch.mock.calls.filter(([, init]) => packet(init).query.includes('DisconnectApp'));
}
function heldEnvelope(answer: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(answer)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function disconnectButton(view: ReturnType<typeof render>) {
  return view.getByRole('button', { name: /disconnectA11y/ });
}
it('uses one actual scoped list for section/detail, fresh30s cache, and current app navigation', async () => {
  const current = fixture();
  const view = render(
    <>
      <PartnerAppsSection />
      <ConnectedAppDetailScreen />
    </>,
    { wrapper: current.wrapper },
  );
  await waitFor(() => expect(view.getByTestId('partner-app-app-A')).toBeTruthy());
  expect(view.getByTestId('connected-app-detail').textContent).toContain('PRIVATE APP A');
  expect(current.performFetch).toHaveBeenCalledTimes(1);
  expect(current.cache.getQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY))).toEqual({ myConnectedApps: apps });
  expect(current.cache.getQueryData(CONNECTED_APPS_QUERY_KEY)).toBeUndefined();
  expect(observedStaleTime(current.cache, current.scope.key(CONNECTED_APPS_QUERY_KEY))).toBe(30_000);
  fireEvent.click(view.getByTestId('partner-app-app-B'));
  expect(ports.push).toHaveBeenCalledWith({ pathname: '/settings/connected-app', params: { id: 'app-B' } });
});
it('does no list work while signed out', async () => {
  const current = fixture();
  ports.authenticated = false;
  render(<PartnerAppsSection />, { wrapper: current.wrapper });
  await act(async () => {
    await Promise.resolve();
  });
  expect(current.performFetch).not.toHaveBeenCalled();
  expect(current.issueLease).not.toHaveBeenCalled();
});
it.each(['B', 'ABA', 'expired'] as const)(
  'refuses held list bodies after %s with current authority live',
  async (change) => {
    const current = fixture();
    const body = heldEnvelope({ data: { myConnectedApps: apps } });
    current.performFetch.mockResolvedValueOnce(body.response);
    const hook = renderHook(() => useMyConnectedApps(), { wrapper: current.wrapper });
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
    if (change === 'expired') {
      current.clock(90_000);
      await current.scope.run((operation) => operation.request('{ viewer { id } }'));
      current.clock(120_001);
    } else {
      current.switchAccount('owned-B');
      if (change === 'ABA') current.switchAccount('owned-A');
      await ports.http!.scope().run((operation) => operation.request('{ viewer { id } }'));
    }
    await act(async () => body.release());
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(current.cache.getQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY))).toBeUndefined();
  },
);
it('disconnects through actual SDK, removes only its original namespace and invalidates that list', async () => {
  const current = fixture();
  current.cache.setQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY), { myConnectedApps: apps });
  current.cache.setQueryData(CONNECTED_APPS_QUERY_KEY, { myConnectedApps: apps });
  const invalidation = vi.spyOn(current.cache, 'invalidateQueries');
  const hook = renderHook(() => useDisconnectApp(), { wrapper: current.wrapper });
  await act(async () => {
    const receipt = await hook.result.current.mutateWithReceipt({ connectionId: 'app-A' });
    receipt.assertCurrent();
    receipt.dispose();
  });
  expect(writes(current)).toHaveLength(1);
  expect(packet(writes(current)[0][1]).variables).toEqual({ connectionId: 'app-A' });
  expect(current.cache.getQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY))).toEqual({
    myConnectedApps: { ...apps, apps: apps.apps.slice(1) },
  });
  expect(current.cache.getQueryData(CONNECTED_APPS_QUERY_KEY)).toEqual({ myConnectedApps: apps });
  expect(invalidation.mock.calls[0][0]?.queryKey).toEqual(current.scope.key(CONNECTED_APPS_QUERY_KEY));
});
it('confirms and disconnects in the actual detail, preserving feedback through intended page deletion', async () => {
  const current = fixture();
  let leave!: () => void;
  function Host() {
    const [open, setOpen] = useState(true);
    leave = () => setOpen(false);
    return open ? <ConnectedAppDetailScreen /> : null;
  }
  ports.back.mockImplementation(() => leave());
  const view = render(<Host />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
  fireEvent.click(disconnectButton(view));
  await waitFor(() => expect(writes(current)).toHaveLength(1));
  await waitFor(() => expect(ports.back).toHaveBeenCalledTimes(1));
  expect(view.queryByTestId('connected-app-detail')).toBeNull();
  await waitFor(() => expect(view.container.textContent).toContain('partnerApps.disconnected'));
  expect(ports.success).toHaveBeenCalledTimes(1);
  current.switchAccount('owned-B');
  await waitFor(() => expect(view.container.textContent).not.toContain('partnerApps.disconnected'));
});
it.each(['targetABA', 'viewABA', 'unmount'] as const)(
  'refuses the original pending confirmation after %s and keeps current controls usable',
  async (change) => {
    const current = fixture();
    const confirm = deferred<boolean>();
    ports.confirm.mockReturnValueOnce(confirm.promise);
    const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
    await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
    fireEvent.click(disconnectButton(view));
    expect(ports.confirm).toHaveBeenCalledTimes(1);
    if (change === 'unmount') view.unmount();
    else if (change === 'targetABA') {
      ports.id = 'app-B';
      view.rerender(<ConnectedAppDetailScreen />);
      ports.id = 'app-A';
      view.rerender(<ConnectedAppDetailScreen />);
    } else {
      current.switchAccount('owned-B');
      current.switchAccount('owned-A');
      ports.scope = ports.http!.scope();
      view.rerender(<ConnectedAppDetailScreen />);
    }
    await act(async () => confirm.resolve(true));
    expect(writes(current)).toHaveLength(0);
    expect(ports.success).not.toHaveBeenCalled();
    expect(ports.back).not.toHaveBeenCalled();
    if (change !== 'unmount') {
      await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
      fireEvent.click(disconnectButton(view));
      await waitFor(() => expect(writes(current)).toHaveLength(1));
    }
  },
);
it('cancels confirmation without a write or feedback', async () => {
  const current = fixture();
  ports.confirm.mockResolvedValue(false);
  const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
  fireEvent.click(disconnectButton(view));
  await waitFor(() => expect(ports.confirm).toHaveBeenCalledTimes(1));
  expect(writes(current)).toHaveLength(0);
  expect(ports.success).not.toHaveBeenCalled();
  expect(ports.error).not.toHaveBeenCalled();
});

it('captures direct mutation caller input before the first helper await', async () => {
  const current = fixture();
  current.cache.setQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY), { myConnectedApps: apps });
  const hook = renderHook(() => useDisconnectApp(), { wrapper: current.wrapper });
  const input = { connectionId: 'app-A' };
  let pending!: ReturnType<typeof hook.result.current.mutateWithReceipt>;
  act(() => {
    pending = hook.result.current.mutateWithReceipt(input);
    input.connectionId = 'app-B';
  });
  await act(async () => {
    const receipt = await pending;
    receipt.assertCurrent();
    receipt.dispose();
  });
  expect(packet(writes(current)[0][1]).variables).toEqual({ connectionId: 'app-A' });
  expect(current.cache.getQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY))).toEqual({
    myConnectedApps: { ...apps, apps: apps.apps.slice(1) },
  });
});

it.each(['section', 'detail'] as const)(
  'refuses private retained %s descendant rendering when only its theme store schedules it',
  async (which) => {
    const current = fixture();
    const view = render(which === 'section' ? <PartnerAppsSection /> : <ConnectedAppDetailScreen />, {
      wrapper: current.wrapper,
    });
    await waitFor(() => expect(view.container.textContent).toContain('PRIVATE APP A'));
    current.switchAccount('owned-B');
    ports.scope = ports.http!.scope();
    act(() => {
      ports.themeRevision += 1;
      for (const notify of ports.themeListeners) notify();
    });
    expect(view.container.textContent).not.toContain('PRIVATE APP A');
  },
);
it.each(['current', 'expired'] as const)(
  'publishes only authentic original %s disconnect error feedback',
  async (cause) => {
    const current = fixture();
    const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
    await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
    const body = heldEnvelope({ errors: [{ message: 'owned live disconnect rejection' }] });
    current.performFetch.mockResolvedValueOnce(body.response);
    fireEvent.click(disconnectButton(view));
    await waitFor(() => expect(writes(current)).toHaveLength(1));
    if (cause === 'expired') {
      current.clock(90_000);
      await current.scope.run((operation) => operation.request('{ viewer { id } }'));
      current.clock(120_001);
    }
    await act(async () => body.release());
    await waitFor(() =>
      expect(
        current.cache
          .getMutationCache()
          .getAll()
          .every((mutation) => mutation.state.status === 'error'),
      ).toBe(true),
    );
    await waitFor(() => expect((disconnectButton(view) as HTMLButtonElement).disabled).toBe(false));
    expect(ports.back).not.toHaveBeenCalled();
    expect(current.cache.getQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY))).toEqual({ myConnectedApps: apps });
    if (cause === 'current') {
      await waitFor(() => expect(view.container.textContent).toContain('partnerApps.disconnectFailed'));
      expect(ports.error).toHaveBeenCalledTimes(1);
    } else {
      expect(view.container.textContent).not.toContain('partnerApps.disconnectFailed');
      expect(ports.error).not.toHaveBeenCalled();
    }
    expect(ports.success).not.toHaveBeenCalled();
  },
);
it('never turns unknown transport failure into authenticated disconnect guidance', async () => {
  const current = fixture();
  const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
  current.performFetch.mockRejectedValueOnce(new Error('not an SDK verdict'));
  fireEvent.click(disconnectButton(view));
  await waitFor(() => expect(writes(current)).toHaveLength(1));
  await waitFor(() =>
    expect(
      current.cache
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.status === 'error'),
    ).toBe(true),
  );
  await waitFor(() => expect((disconnectButton(view) as HTMLButtonElement).disabled).toBe(false));
  expect(view.container.textContent).not.toContain('partnerApps.disconnectFailed');
  expect(ports.error).not.toHaveBeenCalled();
  expect(ports.back).not.toHaveBeenCalled();
});
it('retires quiet original error feedback after E1 expiry even with a live E2', async () => {
  const current = fixture();
  const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
  current.performFetch.mockImplementationOnce(async () => Response.json({ errors: [{ message: 'live verdict' }] }));
  fireEvent.click(disconnectButton(view));
  await waitFor(() => expect(view.container.textContent).toContain('partnerApps.disconnectFailed'));
  expect(ports.error).toHaveBeenCalledTimes(1);
  current.clock(90_000);
  await current.scope.run((operation) => operation.request('{ viewer { id } }'));
  const before = current.performFetch.mock.calls.length;
  current.clock(120_001);
  await waitFor(() => expect(view.container.textContent).not.toContain('partnerApps.disconnectFailed'));
  expect(current.performFetch).toHaveBeenCalledTimes(before);
  expect(ports.error).toHaveBeenCalledTimes(1);
});
it.each(['current', 'target-retired'] as const)(
  'checks original invocation after actual lease acquisition returns %s',
  async (outcome) => {
    const current = fixture();
    const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
    await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
    const held = deferred<void>();
    const entered = deferred<void>();
    const acquire = current.backend.acquireScope.bind(current.backend);
    vi.spyOn(current.backend, 'acquireScope').mockImplementation(async (owner) => {
      const original = await acquire(owner);
      entered.resolve();
      await held.promise;
      return original;
    });
    fireEvent.click(disconnectButton(view));
    await act(async () => {
      await entered.promise;
    });
    if (outcome === 'target-retired') {
      ports.id = 'app-B';
      view.rerender(<ConnectedAppDetailScreen />);
    }
    await act(async () => held.resolve());
    if (outcome === 'current') {
      await waitFor(() => expect(writes(current)).toHaveLength(1));
      await waitFor(() => expect(ports.success).toHaveBeenCalledTimes(1));
    } else {
      await waitFor(() => expect(view.container.textContent).toContain('PRIVATE APP B'));
      expect(writes(current)).toHaveLength(0);
      expect(ports.success).not.toHaveBeenCalled();
      expect(ports.error).not.toHaveBeenCalled();
      expect(ports.back).not.toHaveBeenCalled();
    }
  },
);
it('forces original current retry despite fresh cache and leaves later independent refresh live', async () => {
  const current = fixture();
  current.performFetch.mockImplementationOnce(async () =>
    Response.json({ errors: [{ message: 'owned cold list failure' }] }),
  );
  const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.container.textContent).toContain('partnerApps.loadFailed'));
  const oldRetry = ports.callbacks.at(-1)!;
  act(() => oldRetry());
  await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
  expect(current.performFetch).toHaveBeenCalledTimes(2);
  act(() => oldRetry());
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(current.cache.getQueryState(current.scope.key(CONNECTED_APPS_QUERY_KEY))?.fetchStatus).toBe('idle'),
  );
  view.unmount();
  await current.cache.refetchQueries({
    queryKey: current.scope.key(CONNECTED_APPS_QUERY_KEY),
    exact: true,
    type: 'all',
  });
  expect(current.performFetch).toHaveBeenCalledTimes(4);
});
it('refuses an old section row callback after view ABA while a fresh section can navigate', async () => {
  const current = fixture();
  const view = render(<PartnerAppsSection />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.queryByTestId('partner-app-app-A')).toBeTruthy());
  const old = ports.callbacks[0];
  current.switchAccount('owned-B');
  current.switchAccount('owned-A');
  ports.scope = ports.http!.scope();
  act(() => old());
  expect(ports.push).not.toHaveBeenCalled();
  view.rerender(<PartnerAppsSection />);
  await waitFor(() => expect(view.queryByTestId('partner-app-app-A')).toBeTruthy());
  fireEvent.click(view.getByTestId('partner-app-app-A'));
  expect(ports.push).toHaveBeenCalledTimes(1);
});
it('refuses retained retry after committed app ABA without sending another list packet', async () => {
  const current = fixture();
  current.performFetch.mockImplementationOnce(async () =>
    Response.json({ errors: [{ message: 'owned cold failure' }] }),
  );
  const view = render(<ConnectedAppDetailScreen />, { wrapper: current.wrapper });
  await waitFor(() => expect(view.container.textContent).toContain('partnerApps.loadFailed'));
  const retry = ports.callbacks.at(-1)!;
  ports.id = 'app-B';
  view.rerender(<ConnectedAppDetailScreen />);
  ports.id = 'app-A';
  view.rerender(<ConnectedAppDetailScreen />);
  await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
  const before = current.performFetch.mock.calls.length;
  act(() => retry());
  await act(async () => {
    await Promise.resolve();
  });
  expect(current.performFetch).toHaveBeenCalledTimes(before);
});
it('keeps uninvoked current controls live through actual StrictMode setup', async () => {
  const current = fixture();
  const view = render(
    <StrictMode>
      <ConnectedAppDetailScreen />
    </StrictMode>,
    { wrapper: current.wrapper },
  );
  await waitFor(() => expect(view.queryByTestId('connected-app-detail')).toBeTruthy());
  fireEvent.click(disconnectButton(view));
  await waitFor(() => expect(writes(current)).toHaveLength(1));
  await waitFor(() => expect(ports.success).toHaveBeenCalledTimes(1));
});
it.each(['mutate', 'mutateAsync'] as const)(
  'snapshots caller input at public %s submission and preserves callbacks',
  async (method) => {
    const current = fixture();
    current.cache.setQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY), { myConnectedApps: apps });
    const hook = renderHook(() => useDisconnectApp(), { wrapper: current.wrapper });
    const input = { connectionId: 'app-A' };
    const onSuccess = vi.fn();
    let pending: Promise<unknown> | undefined;
    act(() => {
      if (method === 'mutate') hook.result.current.mutate(input, { onSuccess });
      else pending = hook.result.current.mutateAsync(input, { onSuccess });
      input.connectionId = 'app-B';
    });
    if (pending)
      await act(async () => {
        await pending;
      });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(packet(writes(current)[0][1]).variables).toEqual({ connectionId: 'app-A' });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(current.cache.getQueryData(current.scope.key(CONNECTED_APPS_QUERY_KEY))).toEqual({
      myConnectedApps: { ...apps, apps: apps.apps.slice(1) },
    });
  },
);
function nativeFixture() {
  const current = fixture();
  ports.native = true;
  ports.nativeClient = new GraphQLClient('https://native.owned.test/graphql', { fetch: current.performFetch });
  ports.scope = createHttpQueryScope({
    scope: undefined,
    scoped: false,
    prefix: [],
    isCurrentView: () => true,
    createOperation: (options) => createHttpOperation(undefined, options),
  });
  return current;
}
it('preserves native ignored Query signal,30s raw cache, and SDK completion after unmount', async () => {
  const current = nativeFixture();
  const held = deferred<Response>();
  current.performFetch.mockReturnValueOnce(held.promise);
  let queryContext: import('@tanstack/react-query').QueryFunctionContext | undefined;
  let applicationSignalReads = 0;
  current.cache.setDefaultOptions({
    queries: {
      retry: false,
      persister: (run, context) => {
        queryContext = context;
        return run(
          new Proxy(context, {
            get(target, property, receiver) {
              if (property === 'signal') applicationSignalReads += 1;
              return Reflect.get(target, property, receiver);
            },
          }),
        );
      },
    },
  });
  const hook = renderHook(() => useMyConnectedApps(), { wrapper: current.wrapper });
  await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(1));
  const sdkSignal = (current.performFetch.mock.calls[0][1] as RequestInit).signal!;
  expect(sdkSignal).toBeInstanceOf(AbortSignal);
  expect(sdkSignal.aborted).toBe(false);
  hook.unmount();
  expect(sdkSignal.aborted).toBe(false);
  expect(applicationSignalReads).toBe(0);
  held.resolve(Response.json({ data: { myConnectedApps: apps } }));
  await waitFor(() => expect(current.cache.getQueryData(CONNECTED_APPS_QUERY_KEY)).toEqual({ myConnectedApps: apps }));
  expect(applicationSignalReads).toBe(0);
  expect(queryContext!.signal).not.toBe(sdkSignal);
  expect(observedStaleTime(current.cache, CONNECTED_APPS_QUERY_KEY)).toBe(30_000);
  expect(current.issueLease).not.toHaveBeenCalled();
});
it('preserves native row removal and fire-and-forget invalidation', async () => {
  const current = nativeFixture();
  current.cache.setQueryData(CONNECTED_APPS_QUERY_KEY, { myConnectedApps: apps });
  const held = deferred<void>();
  const invalidation = vi.spyOn(current.cache, 'invalidateQueries').mockReturnValue(held.promise);
  const hook = renderHook(() => useDisconnectApp(), { wrapper: current.wrapper });
  await act(async () => {
    const receipt = await hook.result.current.mutateWithReceipt({ connectionId: 'app-A' });
    receipt.assertCurrent();
    receipt.dispose();
  });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(invalidation).toHaveBeenCalledWith({ queryKey: CONNECTED_APPS_QUERY_KEY });
  expect(current.cache.getQueryData(CONNECTED_APPS_QUERY_KEY)).toEqual({
    myConnectedApps: { ...apps, apps: apps.apps.slice(1) },
  });
  held.resolve();
  expect(current.issueLease).not.toHaveBeenCalled();
});

function observedStaleTime(cache: QueryClient, key: readonly unknown[]): unknown {
  const options = cache.getQueryCache().find({ queryKey: key, exact: true })?.options;
  // QueryCache's erased base type omits observer fields; inspect the real field.
  return options && 'staleTime' in options ? options.staleTime : undefined;
}
