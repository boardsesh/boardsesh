// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, render, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// expo-router and react-native both reach for the native runtime; stub the
// thin surface AuthProvider consumes. `useSegments` returning `[]` keeps the
// provider out of its `<Redirect>` branches so the child tree renders and the
// auth context becomes readable.
vi.mock('expo-router', () => ({
  useSegments: () => [] as string[],
  Redirect: () => null,
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

// Storage + side-effect mocks. Each one just records calls; signOut returning
// successfully (no throw) is the only behaviour the unit cares about.
const getAuthTokenMock = vi.fn();
const isTokenExpiringSoonMock = vi.fn();
vi.mock('../../lib/auth-store', () => ({
  getAuthToken: () => getAuthTokenMock(),
  isTokenExpiringSoon: () => isTokenExpiringSoonMock(),
}));

// checkAuth reports keychain read failures to Sentry; record the calls so the
// rejection test can assert the failure was surfaced (and is a no-op otherwise).
const reportErrorMock = vi.fn();
vi.mock('../../lib/sentry', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

const authSignOutMock = vi.fn();
vi.mock('../../lib/auth', () => ({
  startSignIn: vi.fn(),
  signOut: () => authSignOutMock(),
  signInWithCredentials: vi.fn(),
}));

const clearStoredSessionIdMock = vi.fn();
vi.mock('../../lib/session-store', () => ({
  clearStoredSessionId: () => clearStoredSessionIdMock(),
}));

const clearStoredActiveBoardMock = vi.fn();
vi.mock('../../lib/active-board-store', () => ({
  clearStoredActiveBoard: () => clearStoredActiveBoardMock(),
}));

const resetHttpClientMock = vi.fn();
vi.mock('../../lib/graphql/client', () => ({
  resetHttpClient: () => resetHttpClientMock(),
}));

const disposeWsClientMock = vi.fn();
vi.mock('../../lib/graphql/ws-client', () => ({
  disposeWsClient: () => disposeWsClientMock(),
}));

vi.mock('../../lib/graphql/use-active-board', () => ({
  ACTIVE_BOARD_QUERY_KEY: ['activeBoard'] as const,
}));

// The provider registers its forced-sign-out cleanup against this lib-layer hook
// (and lazily imports ensureFreshToken in checkAuth). Record the register/clear
// calls so the lifecycle test can assert the contract.
const setOnForcedSignOutMock = vi.fn();
const ensureFreshTokenMock = vi.fn().mockResolvedValue(true);
vi.mock('../../lib/auth-interceptor', () => ({
  setOnForcedSignOut: (callback: (() => void) | null) => setOnForcedSignOutMock(callback),
  ensureFreshToken: () => ensureFreshTokenMock(),
}));

import { AuthProvider, useAuth } from '../auth-provider';

describe('AuthProvider.signOut', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    authSignOutMock.mockReset();
    clearStoredSessionIdMock.mockReset();
    clearStoredActiveBoardMock.mockReset();
    resetHttpClientMock.mockReset();
    disposeWsClientMock.mockReset();
    reportErrorMock.mockReset();
    // Default: a signed-in session whose token is fresh, so checkAuth flips
    // isAuthenticated to true without taking the refresh branch.
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    authSignOutMock.mockResolvedValue(undefined);
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
  });

  it('clears every cached React Query so cached data does not bleed into the next user', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Seed two unrelated queries: one mirrors what
    // useMobileClimbActionsData writes; the other stands in for any other
    // user-scoped data (beta links, session summary, …).
    queryClient.setQueryData(['userPlaylists'], [{ id: 'p-1', name: "User A's playlist" }]);
    queryClient.setQueryData(['betaLinks', 'kilter', 'climb-x'], [{ url: 'https://example.com' }]);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await act(async () => {
      await result.current.signOut();
    });

    // The exact mechanism the cross-user leak fix relies on: a blanket
    // queryClient.clear() at the auth boundary. Both seeded keys go away.
    // Not asserting on `result.current.isAuthenticated` here — once it flips
    // to false the provider returns its `<Redirect>` branch (mocked to
    // null), so the renderHook's last captured snapshot stays stale. The
    // queryClient is the durable check.
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
    expect(queryClient.getQueryData(['betaLinks', 'kilter', 'climb-x'])).toBeUndefined();
  });

  it('runs the auth-side cleanup before clearing the cache', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['activeBoard'], { uuid: 'b-a' });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await act(async () => {
      await result.current.signOut();
    });

    // Every cleanup step the comment in signOut promises. Each one is a
    // single mock call per signOut invocation.
    expect(authSignOutMock).toHaveBeenCalledTimes(1);
    expect(clearStoredSessionIdMock).toHaveBeenCalledTimes(1);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledTimes(1);
    expect(resetHttpClientMock).toHaveBeenCalledTimes(1);
    expect(disposeWsClientMock).toHaveBeenCalledTimes(1);
    // Active board cache was wiped — both the targeted removeQueries and the
    // subsequent clear() do this; verifying the end state is enough.
    expect(queryClient.getQueryData(['activeBoard'])).toBeUndefined();
  });
});

describe('AuthProvider forced sign-out registration', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    setOnForcedSignOutMock.mockReset();
    authSignOutMock.mockReset();
    clearStoredSessionIdMock.mockReset();
    clearStoredActiveBoardMock.mockReset();
    resetHttpClientMock.mockReset();
    disposeWsClientMock.mockReset();
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    authSignOutMock.mockResolvedValue(undefined);
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
  });

  // The interceptor's null-guard is the safety net, but the provider owns the
  // contract: register a callable while mounted, clear it (null) on unmount so a
  // 401 firing after teardown can't drive a dead provider.
  it('registers the forced-sign-out hook on mount and clears it on unmount', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{null}</AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(setOnForcedSignOutMock).toHaveBeenCalled());
    const registered = setOnForcedSignOutMock.mock.calls.at(-1)?.[0];
    expect(typeof registered).toBe('function');

    unmount();
    expect(setOnForcedSignOutMock).toHaveBeenLastCalledWith(null);
  });

  // Behavioural coverage of the forced path: firing the registered hook must run
  // the same cleanup a manual sign-out does — minus the token revoke, which the
  // interceptor already did before invoking the hook (no double-revoke).
  it('runs the full signed-out cleanup when the registered hook fires, without re-revoking', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'p-1', name: "User A's playlist" }]);

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{null}</AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(setOnForcedSignOutMock).toHaveBeenCalled());
    const forcedCleanup = setOnForcedSignOutMock.mock.calls.at(-1)?.[0] as () => void;

    await act(async () => {
      forcedCleanup();
      // Let the async runSignedOutCleanup (allSettled store clears → teardown) settle.
      await Promise.resolve();
    });

    await waitFor(() => expect(disposeWsClientMock).toHaveBeenCalledTimes(1));
    expect(clearStoredSessionIdMock).toHaveBeenCalledTimes(1);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledTimes(1);
    expect(resetHttpClientMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
    // The interceptor revoked on the forced path; the provider must not revoke again.
    expect(authSignOutMock).not.toHaveBeenCalled();
  });
});

describe('AuthProvider.checkAuth keychain read failure', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    reportErrorMock.mockReset();
    isTokenExpiringSoonMock.mockResolvedValue(false);
  });

  // Repro for A11-auth-onboarding-001: a locked-keychain launch makes
  // SecureStore.getItemAsync REJECT (not return null). Without a try/catch in
  // checkAuth the rejection escapes, isLoading never flips to false, onReady
  // never fires, and the splash screen hangs forever. The fix treats a read
  // failure as logged-out so the loading gate always resolves.
  it('still resolves the loading gate (onReady fires) when the token read rejects', async () => {
    getAuthTokenMock.mockRejectedValue(new Error('keychain locked'));
    const onReady = vi.fn();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider onReady={onReady}>{children}</AuthProvider>
      </QueryClientProvider>
    );

    render(wrapper({ children: null }));

    // The whole point: the splash gate must release even though the read threw.
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    // The failure is surfaced to Sentry rather than swallowed silently.
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });
});
