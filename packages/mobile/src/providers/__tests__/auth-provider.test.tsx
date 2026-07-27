// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, screen, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const redirectMock = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ OS: 'ios' }));
const routerState = vi.hoisted(() => ({ segments: [] as string[] }));
const authTokenEventsState = vi.hoisted(() => ({
  listener: null as
    | ((token: string | null, source: 'local' | 'remote' | 'remote-signout' | 'session' | 'hint') => void)
    | null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
const webSessionIdentityState = vi.hoisted(() => ({
  userId: 'user-1',
  authSessionId: 'login-1',
  unavailableIdentity: null as { userId: string; authSessionId: string } | null,
}));
const userStorageOwnerState = vi.hoisted(() => ({
  current: null as { userId: string; authSessionId: string } | null,
  set: vi.fn(),
}));
const bumpAuthTransportRevisionMock = vi.hoisted(() => vi.fn());
const consumeFreshOAuthPendingMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());

// expo-router and react-native both reach for the native runtime; stub the
// thin surface AuthProvider consumes. `useSegments` returning `[]` keeps the
// provider out of its `<Redirect>` branches so the child tree renders and the
// auth context becomes readable.
vi.mock('expo-router', () => ({
  useSegments: () => routerState.segments,
  Redirect: ({ href }: { href: string }) => {
    redirectMock(href);
    return null;
  },
}));

vi.mock('react-native', () => ({
  Platform: platformState,
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

// The loading-state splash renders react-native/expo-image primitives this
// jsdom-mocked env doesn't provide; stub it to a detectable text marker (a
// component may return a raw string) so a test can assert the loading window
// renders the splash rather than a blank tree.
vi.mock('../../components/AppLoadingSplash', () => ({
  AppLoadingSplash: () => 'app-loading-splash',
}));

vi.mock('../../lib/screenshot-mode', () => ({
  SCREENSHOT_USER_EMAIL: 'screenshots@example.com',
  SCREENSHOT_USER_PASSWORD: 'screenshot-password',
}));

vi.mock('../../lib/auth-token-events', () => ({
  subscribeAuthTokenChanges: (
    listener: (token: string | null, source: 'local' | 'remote' | 'remote-signout' | 'session' | 'hint') => void,
  ) => {
    authTokenEventsState.listener = listener;
    authTokenEventsState.subscribe(listener);
    return () => {
      if (authTokenEventsState.listener === listener) authTokenEventsState.listener = null;
      authTokenEventsState.unsubscribe();
    };
  },
}));

vi.mock('../../lib/auth-session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/auth-session')>();
  return {
    ...original,
    resolveAuthSession: async () => {
      if (platformState.OS === 'web' && webSessionIdentityState.unavailableIdentity) {
        return {
          status: 'unavailable' as const,
          error: new Error('bridge unavailable'),
          confirmedIdentity: webSessionIdentityState.unavailableIdentity,
          identityInvalidated: true,
        };
      }
      const result = await original.resolveAuthSession();
      if (platformState.OS === 'web' && result.status === 'authenticated') {
        return {
          ...result,
          userId: webSessionIdentityState.userId,
          authSessionId: webSessionIdentityState.authSessionId,
        };
      }
      return result;
    },
  };
});

beforeEach(() => {
  platformState.OS = 'ios';
  routerState.segments = [];
  redirectMock.mockReset();
  isAuthCredentialGenerationCurrentMock.mockReset();
  isAuthCredentialGenerationCurrentMock.mockReturnValue(true);
  authTokenEventsState.listener = null;
  authTokenEventsState.subscribe.mockReset();
  authTokenEventsState.unsubscribe.mockReset();
  webSessionIdentityState.userId = 'user-1';
  webSessionIdentityState.authSessionId = 'login-1';
  webSessionIdentityState.unavailableIdentity = null;
  userStorageOwnerState.current = null;
  userStorageOwnerState.set.mockReset();
  userStorageOwnerState.set.mockImplementation((owner) => {
    userStorageOwnerState.current = owner as { userId: string; authSessionId: string } | null;
  });
  bumpAuthTransportRevisionMock.mockReset();
  consumeFreshOAuthPendingMock.mockReset();
  consumeFreshOAuthPendingMock.mockResolvedValue(null);
  trackMock.mockReset();
  captureAuthCredentialGenerationMock.mockReset();
  captureAuthCredentialGenerationMock.mockReturnValue(1);
  authSignInWithCredentialsMock.mockReset();
  clearStoredQueueSnapshotMock.mockReset();
  clearStoredQueueSnapshotMock.mockResolvedValue(undefined);
  clearAllCreateClimbDraftsMock.mockReset();
  clearAllCreateClimbDraftsMock.mockResolvedValue(undefined);
  clearSessionCommentDraftMock.mockReset();
  clearSessionCommentDraftMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Storage + side-effect mocks. Each one just records calls; signOut returning
// successfully (no throw) is the only behaviour the unit cares about.
const getAuthTokenMock = vi.fn();
const isTokenExpiringSoonMock = vi.fn();
const isAuthCredentialGenerationCurrentMock = vi.fn();
const captureAuthCredentialGenerationMock = vi.fn(() => 1);
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => captureAuthCredentialGenerationMock(),
  getAuthToken: () => getAuthTokenMock(),
  isAuthCredentialGenerationCurrent: (...args: unknown[]) => isAuthCredentialGenerationCurrentMock(...args),
  isTokenExpiringSoon: () => isTokenExpiringSoonMock(),
}));

// checkAuth reports keychain read failures; record the calls so the
// rejection test can assert the failure was surfaced (and is a no-op otherwise).
const reportErrorMock = vi.fn();
vi.mock('../../lib/error-reporting', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

vi.mock('../../lib/analytics', () => ({
  reset: vi.fn(),
  track: (...args: unknown[]) => trackMock(...args),
}));

vi.mock('../../lib/oauth-pending-store', () => ({
  consumeFreshOAuthPending: (...args: unknown[]) => consumeFreshOAuthPendingMock(...args),
}));

const authSignOutMock = vi.fn();
const authRegisterMock = vi.fn();
const authSignInWithCredentialsMock = vi.fn();
vi.mock('../../lib/auth', () => ({
  signInWithApple: vi.fn(),
  signInWithGoogle: vi.fn(),
  signInWithGoogleWeb: vi.fn(),
  signInWithAppleWeb: vi.fn(),
  signOutForGeneration: (...args: unknown[]) => authSignOutMock(...args),
  signInWithCredentials: (...args: unknown[]) => authSignInWithCredentialsMock(...args),
  registerWithCredentials: (...args: unknown[]) => authRegisterMock(...args),
}));

const clearStoredSessionIdMock = vi.fn();
vi.mock('../../lib/session-store', () => ({
  clearStoredSessionId: (...args: unknown[]) => clearStoredSessionIdMock(...args),
  // Device provenance for the leave-vs-end emphasis (#3502).
  getStoredCreatedSessionId: vi.fn(async () => null),
  setStoredCreatedSessionId: vi.fn(async () => {}),
  clearStoredCreatedSessionId: vi.fn(async () => {}),
}));

const clearStoredActiveBoardMock = vi.fn();
vi.mock('../../lib/active-board-store', () => ({
  clearStoredActiveBoard: (...args: unknown[]) => clearStoredActiveBoardMock(...args),
}));

const clearStoredQueueSnapshotMock = vi.fn();
vi.mock('../../lib/queue-snapshot-store', () => ({
  clearStoredQueueSnapshot: (...args: unknown[]) => clearStoredQueueSnapshotMock(...args),
}));

const clearAllCreateClimbDraftsMock = vi.fn();
vi.mock('../../lib/create-climb-draft-store', () => ({
  clearAllCreateClimbDrafts: (...args: unknown[]) => clearAllCreateClimbDraftsMock(...args),
}));

const clearSessionCommentDraftMock = vi.fn();
vi.mock('../../lib/session-comment-draft-store', () => ({
  clearSessionCommentDraft: (...args: unknown[]) => clearSessionCommentDraftMock(...args),
}));

vi.mock('../../lib/user-storage-owner', () => ({
  setCurrentUserStorageOwner: (owner: { userId: string; authSessionId: string } | null) => {
    userStorageOwnerState.set(owner);
  },
}));

vi.mock('../../lib/auth-transport-revision', () => ({
  bumpAuthTransportRevision: () => bumpAuthTransportRevisionMock(),
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

const getDatabaseHandleMock = vi.fn((): unknown => null);
vi.mock('../../db', () => ({
  getDatabaseHandle: () => getDatabaseHandleMock(),
  clearUserData: vi.fn(),
}));

const drainMutationQueueMock = vi.fn(async (..._args: unknown[]) => {});
const getPendingCountMock = vi.fn(async (..._args: unknown[]) => 0);
vi.mock('@boardsesh/offline-sync', () => ({
  getPendingCount: (...args: unknown[]) => getPendingCountMock(...args),
  setSigningOut: vi.fn(),
}));
vi.mock('../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: (...args: unknown[]) => drainMutationQueueMock(...args),
}));

const stopTokenManagementMock = vi.fn(async () => {});
vi.mock('../../notifications', () => ({
  stopTokenManagement: (_unregister: unknown) => stopTokenManagementMock(),
}));

// The provider clears the per-user offline-boards setting on sign-out. Stub the
// settings barrel so the test's static graph never pulls react-native-mmkv (→ the
// react-native Flow entry, which Rolldown's collection scan can't parse under RN 0.86).
vi.mock('../../settings', () => ({
  setSetting: vi.fn(),
}));

// The provider registers its forced-sign-out cleanup against this lib-layer hook
// (and lazily imports ensureFreshToken in checkAuth). Record the register/clear
// calls so the lifecycle test can assert the contract.
const setOnForcedSignOutMock = vi.fn();
const ensureFreshTokenMock = vi.fn().mockResolvedValue(true);
type MockRefreshResult =
  | { status: 'refreshed'; generation: number }
  | { status: 'rejected'; generation: number }
  | { status: 'unavailable'; generation: number }
  | { status: 'superseded' };
// resolveAuthSession refreshes an expiring token through the status-returning
// deduplicatedRefresh (not the boolean ensureFreshToken), so the refresh-fail
// and superseded scenarios drive this mock's 4-way status.
const deduplicatedRefreshMock = vi.fn<() => Promise<MockRefreshResult>>().mockResolvedValue({
  status: 'refreshed',
  generation: 1,
});
vi.mock('../../lib/auth-interceptor', () => ({
  setOnForcedSignOut: (callback: (() => void) | null) => setOnForcedSignOutMock(callback),
  ensureFreshToken: () => ensureFreshTokenMock(),
  deduplicatedRefresh: () => deduplicatedRefreshMock(),
}));

import { AuthProvider, useAuth } from '../auth-provider';

describe('AuthProvider loading state', () => {
  beforeEach(() => {
    // A signed-in, fresh-token session so checkAuth flips isLoading false and
    // isAuthenticated true (segments=[] keeps it out of the redirect branches),
    // letting the tree swap from the splash to the app children.
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
  });

  it('renders the splash placeholder (not a blank tree) while auth resolves, then swaps to children', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <span data-testid="app-children">ready</span>
        </AuthProvider>
      </QueryClientProvider>,
    );

    // Synchronously after mount, auth is still loading: the splash shows and the
    // app tree is withheld. This is the web FCP win — a painted splash, not blank.
    expect(screen.getByText('app-loading-splash')).toBeTruthy();
    expect(screen.queryByTestId('app-children')).toBeNull();

    // Once the session resolves, the placeholder is replaced by the app tree.
    await waitFor(() => expect(screen.queryByTestId('app-children')).not.toBeNull());
    expect(screen.queryByText('app-loading-splash')).toBeNull();
  });
});

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
    redirectMock.mockReset();
    // Default: a signed-in session whose token is fresh, so checkAuth flips
    // isAuthenticated to true without taking the refresh branch.
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    authSignOutMock.mockResolvedValue(true);
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
    // Create-climb and session-recap drafts are wiped for account isolation
    // only on web. Native sign-out keeps its origin behavior and must not touch
    // these drafts, so this stays native-neutral when the PR ships via OTA.
    expect(clearAllCreateClimbDraftsMock).not.toHaveBeenCalled();
    expect(clearSessionCommentDraftMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).toHaveBeenCalledTimes(1);
    expect(disposeWsClientMock).toHaveBeenCalledTimes(1);
    // Active board cache was wiped — both the targeted removeQueries and the
    // subsequent clear() do this; verifying the end state is enough.
    expect(queryClient.getQueryData(['activeBoard'])).toBeUndefined();
  });

  it('clears provider and user state even when durable manual sign-out fails', async () => {
    const durableSignOutError = new Error('NextAuth sign-out unavailable');
    authSignOutMock.mockRejectedValueOnce(durableSignOutError);
    const queryClient = new QueryClient();
    queryClient.setQueryData(['userPlaylists'], [{ id: 'playlist-a' }]);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.signOut();
      } catch (error) {
        caughtError = error;
      }
    });

    expect(caughtError).toBe(durableSignOutError);
    expect(clearStoredSessionIdMock).toHaveBeenCalledTimes(1);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledTimes(1);
    expect(resetHttpClientMock).toHaveBeenCalledTimes(1);
    expect(disposeWsClientMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
  });

  it('surfaces account-deleted credential cleanup failure after isolating local user state', async () => {
    const credentialCleanupError = new Error('SecureStore credential deletion failed');
    authSignOutMock.mockRejectedValueOnce(credentialCleanupError);
    const queryClient = new QueryClient();
    queryClient.setQueryData(['userPlaylists'], [{ id: 'playlist-a' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.signOut('account_deleted');
      } catch (error) {
        caughtError = error;
      }
    });

    expect(caughtError).toBe(credentialCleanupError);
    expect(reportErrorMock).toHaveBeenCalledWith(credentialCleanupError);
    expect(clearStoredSessionIdMock).toHaveBeenCalledTimes(1);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledTimes(1);
    expect(resetHttpClientMock).toHaveBeenCalledTimes(1);
    expect(disposeWsClientMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
  });

  it('does not sign out a newer credential owner that arrives during the queue drain', async () => {
    platformState.OS = 'web';
    getDatabaseHandleMock.mockReturnValue({ tag: 'db' });
    getPendingCountMock.mockResolvedValue(1);
    let releaseDrain!: () => void;
    drainMutationQueueMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseDrain = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'new-owner-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    const pendingSignOut = result.current.signOut();
    await vi.waitFor(() => expect(drainMutationQueueMock).toHaveBeenCalledOnce());
    isAuthCredentialGenerationCurrentMock.mockReturnValue(false);
    releaseDrain();

    await act(async () => pendingSignOut);
    expect(authSignOutMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'new-owner-playlist' }]);
  });

  it('keeps a newer cross-tab login after the old owner sign-out is superseded in flight', async () => {
    platformState.OS = 'web';
    let currentGeneration = 1;
    captureAuthCredentialGenerationMock.mockImplementation(() => currentGeneration);
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let finishOldSignOut!: (performed: boolean) => void;
    authSignOutMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishOldSignOut = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    const pendingSignOut = result.current.signOut();
    await vi.waitFor(() => expect(authSignOutMock).toHaveBeenCalledWith(1));

    currentGeneration = 2;
    webSessionIdentityState.userId = 'user-2';
    webSessionIdentityState.authSessionId = 'login-2';
    getAuthTokenMock.mockResolvedValue('new-owner-jwt');
    act(() => authTokenEventsState.listener?.(null, 'remote'));
    await waitFor(() => expect(userStorageOwnerState.current).toEqual({ userId: 'user-2', authSessionId: 'login-2' }));
    queryClient.setQueryData(['userPlaylists'], [{ id: 'new-owner-playlist' }]);

    finishOldSignOut(false);
    await act(async () => pendingSignOut);

    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'new-owner-playlist' }]);
    expect(userStorageOwnerState.current).toEqual({ userId: 'user-2', authSessionId: 'login-2' });
  });

  it('keeps a newer native login when the old owner credential clear finishes successfully', async () => {
    let currentGeneration = 1;
    captureAuthCredentialGenerationMock.mockImplementation(() => currentGeneration);
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    let finishOldSignOut!: (performed: boolean) => void;
    authSignOutMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishOldSignOut = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    const pendingSignOut = result.current.signOut();
    await vi.waitFor(() => expect(authSignOutMock).toHaveBeenCalledWith(1));
    currentGeneration = 3;
    queryClient.setQueryData(['userPlaylists'], [{ id: 'new-owner-playlist' }]);
    finishOldSignOut(false);

    await act(async () => pendingSignOut);
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).not.toHaveBeenCalled();
    expect(disposeWsClientMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'new-owner-playlist' }]);
  });

  it('keeps a newer native login when the old owner credential clear fails', async () => {
    let currentGeneration = 1;
    captureAuthCredentialGenerationMock.mockImplementation(() => currentGeneration);
    isAuthCredentialGenerationCurrentMock.mockImplementation((generation: number) => generation === currentGeneration);
    const oldCleanupError = new Error('old credential cleanup failed');
    let failOldSignOut!: (error: unknown) => void;
    authSignOutMock.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        failOldSignOut = reject;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    const pendingSignOut = result.current.signOut();
    await vi.waitFor(() => expect(authSignOutMock).toHaveBeenCalledWith(1));
    currentGeneration = 3;
    queryClient.setQueryData(['userPlaylists'], [{ id: 'new-owner-playlist' }]);
    failOldSignOut(oldCleanupError);

    let caughtError: unknown;
    await act(async () => {
      try {
        await pendingSignOut;
      } catch (error) {
        caughtError = error;
      }
    });
    expect(caughtError).toBe(oldCleanupError);
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).not.toHaveBeenCalled();
    expect(disposeWsClientMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'new-owner-playlist' }]);
  });
});

describe('AuthProvider.register', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    authRegisterMock.mockReset();
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
  });

  it('does not resolve a session after web registration requires verification', async () => {
    authRegisterMock.mockResolvedValue({
      success: true,
      authenticated: false,
      requiresVerification: true,
    });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeRegistration = getAuthTokenMock.mock.calls.length;

    await expect(result.current.register('new@example.com', 'password')).resolves.toEqual({
      success: true,
      authenticated: false,
      requiresVerification: true,
    });

    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeRegistration);
  });
});

describe('AuthProvider Expo-web OAuth completion', () => {
  beforeEach(() => {
    platformState.OS = 'web';
    getAuthTokenMock.mockReset();
    getAuthTokenMock.mockResolvedValue('backend-jwe');
    isTokenExpiringSoonMock.mockReset();
    isTokenExpiringSoonMock.mockResolvedValue(false);
  });

  it('consumes a pending attempt after the returned web session is authenticated', async () => {
    consumeFreshOAuthPendingMock.mockResolvedValue({
      provider: 'apple',
      attemptedAt: Date.now(),
      isRegistration: true,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('Login Succeeded', {
        auth_method: 'apple',
        flow: 'web',
        is_registration: true,
      }),
    );
    expect(consumeFreshOAuthPendingMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refreshAuthState();
    });
    expect(consumeFreshOAuthPendingMock).toHaveBeenCalledTimes(1);
  });
});

describe('AuthProvider.signOut mutation-queue drain gating', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    authSignOutMock.mockReset();
    getDatabaseHandleMock.mockReset();
    drainMutationQueueMock.mockReset();
    getPendingCountMock.mockReset();
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    authSignOutMock.mockResolvedValue(true);
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
    drainMutationQueueMock.mockResolvedValue(undefined);
  });

  async function signOutWithQueueState(pendingCount: number) {
    getDatabaseHandleMock.mockReturnValue({ tag: 'db' });
    getPendingCountMock.mockResolvedValue(pendingCount);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  }

  // The best-effort drain is gated on the queue being NON-EMPTY, not on the
  // offline feature flag: leftover writes queued while the flag was on must
  // still flush after a rollback, while the (vastly more common) empty-queue
  // sign-out pays one local COUNT and proceeds immediately — pre-offline
  // latency for every flag-off user.
  it('drains the queue during sign-out when writes are pending', async () => {
    await signOutWithQueueState(3);
    expect(getPendingCountMock).toHaveBeenCalled();
    expect(drainMutationQueueMock).toHaveBeenCalledTimes(1);
  });

  it('skips the drain entirely when the queue is empty', async () => {
    await signOutWithQueueState(0);
    expect(getPendingCountMock).toHaveBeenCalled();
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });

  it('skips both the count and the drain when there is no local database', async () => {
    getDatabaseHandleMock.mockReturnValue(null);
    getPendingCountMock.mockResolvedValue(5);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

    expect(getPendingCountMock).not.toHaveBeenCalled();
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });
});

describe('AuthProvider forced sign-out registration', () => {
  beforeEach(() => {
    platformState.OS = 'web';
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    setOnForcedSignOutMock.mockReset();
    authSignOutMock.mockReset();
    clearStoredSessionIdMock.mockReset();
    clearStoredActiveBoardMock.mockReset();
    resetHttpClientMock.mockReset();
    disposeWsClientMock.mockReset();
    stopTokenManagementMock.mockReset();
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
    stopTokenManagementMock.mockResolvedValue(undefined);
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

  it('sets the screenshot login scope before authenticated children mount', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    getAuthTokenMock.mockResolvedValueOnce(null).mockResolvedValue('screenshot-jwt');
    authSignInWithCredentialsMock.mockResolvedValue({ success: true });
    const observedOwners: Array<{ userId: string; authSessionId: string } | null> = [];
    const OwnerProbe = () => {
      observedOwners.push(userStorageOwnerState.current);
      return null;
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OwnerProbe />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(observedOwners).not.toHaveLength(0));
    expect(authSignInWithCredentialsMock).toHaveBeenCalledWith('screenshots@example.com', 'screenshot-password');
    expect(observedOwners[0]).toEqual({ userId: 'user-1', authSessionId: 'login-1' });
  });

  it('revalidates a remote sign-in or stale signal without cleaning authenticated user state', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'current-user-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    await waitFor(() => expect(authTokenEventsState.listener).not.toBeNull());
    const authReadsBeforeSignal = getAuthTokenMock.mock.calls.length;

    act(() => authTokenEventsState.listener?.(null, 'remote'));
    expect(resetHttpClientMock).toHaveBeenCalledOnce();
    expect(disposeWsClientMock).toHaveBeenCalledOnce();
    await waitFor(() => expect(getAuthTokenMock.mock.calls.length).toBeGreaterThan(authReadsBeforeSignal));

    expect(authSignOutMock).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'current-user-playlist' }]);
  });

  it('revalidates a benign NextAuth getSession hint without disposing current transports', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeHint = getAuthTokenMock.mock.calls.length;

    act(() => authTokenEventsState.listener?.('jwt-token', 'hint'));

    expect(resetHttpClientMock).not.toHaveBeenCalled();
    expect(disposeWsClientMock).not.toHaveBeenCalled();
    await waitFor(() => expect(getAuthTokenMock.mock.calls.length).toBeGreaterThan(authReadsBeforeHint));
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(userStorageOwnerState.current).toEqual({ userId: 'user-1', authSessionId: 'login-1' });
  });

  it('restarts session subscriptions after a same-user credential login rotates the login scope', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    await waitFor(() => expect(authTokenEventsState.listener).not.toBeNull());
    const previousOwner = { userId: 'user-1', authSessionId: 'login-1' };

    authSignInWithCredentialsMock.mockImplementation(async () => {
      webSessionIdentityState.authSessionId = 'login-2';
      authTokenEventsState.listener?.(null, 'local');
      return { success: true };
    });
    await act(async () => {
      await result.current.signInWithCredentials('climber@example.com', 'password');
    });

    expect(disposeWsClientMock).toHaveBeenCalled();
    expect(clearStoredSessionIdMock).toHaveBeenCalledWith(previousOwner);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledWith(previousOwner);
    expect(clearStoredQueueSnapshotMock).toHaveBeenCalledWith(previousOwner);
    expect(userStorageOwnerState.current).toEqual({ userId: 'user-1', authSessionId: 'login-2' });
    expect(bumpAuthTransportRevisionMock).toHaveBeenCalledOnce();
  });

  it('clears old-user state before adopting a different authenticated identity', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'user-1-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    webSessionIdentityState.userId = 'user-2';
    webSessionIdentityState.authSessionId = 'login-2';
    act(() => authTokenEventsState.listener?.(null, 'remote'));

    await waitFor(() => expect(clearStoredSessionIdMock).toHaveBeenCalledOnce());
    const previousOwner = { userId: 'user-1', authSessionId: 'login-1' };
    expect(clearStoredSessionIdMock).toHaveBeenCalledWith(previousOwner);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledWith(previousOwner);
    expect(clearStoredQueueSnapshotMock).toHaveBeenCalledWith(previousOwner);
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(userStorageOwnerState.current).toEqual({ userId: 'user-2', authSessionId: 'login-2' });
  });

  it('hides and cleans A when B is confirmed but the backend token bridge is unavailable', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'user-a-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    webSessionIdentityState.unavailableIdentity = { userId: 'user-2', authSessionId: 'login-2' };
    act(() => authTokenEventsState.listener?.(null, 'session'));

    await waitFor(() => expect(clearStoredSessionIdMock).toHaveBeenCalledOnce());
    expect(clearStoredSessionIdMock).toHaveBeenCalledWith({ userId: 'user-1', authSessionId: 'login-1' });
    expect(clearStoredQueueSnapshotMock).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
    expect(userStorageOwnerState.current).toBeNull();
  });

  it('cleans user state only after remote revalidation confirms logout', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'old-user-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    getAuthTokenMock.mockResolvedValue(null);
    act(() => authTokenEventsState.listener?.(null, 'remote'));

    await waitFor(() => expect(clearStoredSessionIdMock).toHaveBeenCalledOnce());
    expect(clearStoredActiveBoardMock).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
    expect(authSignOutMock).not.toHaveBeenCalled();
  });

  it('isolates a confirmed remote sign-out without waiting for session revalidation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'old-user-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeSignal = getAuthTokenMock.mock.calls.length;

    act(() => authTokenEventsState.listener?.(null, 'remote-signout'));

    expect(resetHttpClientMock).toHaveBeenCalled();
    expect(disposeWsClientMock).toHaveBeenCalled();
    expect(userStorageOwnerState.current).toBeNull();
    await waitFor(() => expect(clearStoredSessionIdMock).toHaveBeenCalledOnce());
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeSignal);
    await waitFor(() => expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined());
    expect(authSignOutMock).not.toHaveBeenCalled();
  });

  it('coalesces duplicate remote signals into one anonymous cleanup', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'old-user-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    let resolveFirstRevalidation!: (token: string | null) => void;
    getAuthTokenMock.mockReset();
    getAuthTokenMock
      .mockReturnValueOnce(
        new Promise<string | null>((resolve) => {
          resolveFirstRevalidation = resolve;
        }),
      )
      .mockResolvedValue(null);

    act(() => {
      authTokenEventsState.listener?.(null, 'remote');
      authTokenEventsState.listener?.(null, 'remote');
    });
    resolveFirstRevalidation(null);

    await waitFor(() => expect(clearStoredSessionIdMock).toHaveBeenCalledOnce());
    expect(clearStoredActiveBoardMock).toHaveBeenCalledOnce();
    await waitFor(() => expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined());
  });

  it('disposes transports promptly and prevents stale cleanup from erasing a newer login', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'old-user-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const refreshAuthState = result.current.refreshAuthState;

    let releaseCleanup!: () => void;
    stopTokenManagementMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }),
    );
    getAuthTokenMock.mockResolvedValue(null);
    act(() => authTokenEventsState.listener?.(null, 'remote'));

    // These happen in the listener, before resolveAuthSession or cleanup awaits.
    expect(resetHttpClientMock).toHaveBeenCalledOnce();
    expect(disposeWsClientMock).toHaveBeenCalledOnce();
    await waitFor(() => expect(stopTokenManagementMock).toHaveBeenCalledOnce());

    getAuthTokenMock.mockResolvedValue('new-user-jwt');
    queryClient.setQueryData(['userPlaylists'], [{ id: 'new-user-playlist' }]);
    const newerLoginCheck = refreshAuthState();
    releaseCleanup();
    await newerLoginCheck;

    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).toHaveBeenCalledOnce();
    expect(disposeWsClientMock).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'new-user-playlist' }]);
  });

  it('lets a second remote sign-in supersede anonymous cleanup immediately', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'old-user-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    let releaseCleanup!: () => void;
    stopTokenManagementMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }),
    );
    getAuthTokenMock.mockResolvedValue(null);
    act(() => authTokenEventsState.listener?.(null, 'remote'));
    await waitFor(() => expect(stopTokenManagementMock).toHaveBeenCalledOnce());

    getAuthTokenMock.mockResolvedValue('same-user-new-jwt');
    queryClient.setQueryData(['userPlaylists'], [{ id: 'new-user-playlist' }]);
    const authReadsBeforeSecondSignal = getAuthTokenMock.mock.calls.length;
    act(() => authTokenEventsState.listener?.(null, 'remote'));
    releaseCleanup();

    await waitFor(() => expect(getAuthTokenMock.mock.calls.length).toBeGreaterThan(authReadsBeforeSecondSignal));
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'new-user-playlist' }]);
  });

  it('bounds a hung cleanup phase so a later remote sign-in is not starved', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    stopTokenManagementMock.mockReturnValueOnce(new Promise<void>(() => {}));
    getAuthTokenMock.mockResolvedValue(null);
    act(() => authTokenEventsState.listener?.(null, 'remote'));
    await waitFor(() => expect(stopTokenManagementMock).toHaveBeenCalledOnce());

    getAuthTokenMock.mockResolvedValue('recovered-jwt');
    const authReadsBeforeRecovery = getAuthTokenMock.mock.calls.length;
    act(() => authTokenEventsState.listener?.(null, 'remote'));

    await waitFor(() => expect(getAuthTokenMock.mock.calls.length).toBeGreaterThan(authReadsBeforeRecovery), {
      timeout: 2000,
    });
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
  });
});

describe('AuthProvider.checkAuth signed-out cleanup', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    authSignOutMock.mockReset();
    clearStoredSessionIdMock.mockReset();
    clearStoredActiveBoardMock.mockReset();
    resetHttpClientMock.mockReset();
    disposeWsClientMock.mockReset();
    ensureFreshTokenMock.mockReset();
    setOnForcedSignOutMock.mockReset();
    reportErrorMock.mockReset();
    // Default: a signed-in session with a fresh token so the first checkAuth
    // authenticates without taking the refresh branch.
    deduplicatedRefreshMock.mockReset();
    deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 });
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    ensureFreshTokenMock.mockResolvedValue(true);
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
  });

  // The #2685 bug: an expiry-triggered logout (token within the expiry window,
  // proactive refresh fails in checkAuth — NOT a live 401, so the interceptor's
  // forced-sign-out never fires) used to only flip isAuthenticated. It must now
  // run the same cross-user cleanup signOut does, or the next user on a shared
  // device inherits the previous user's cache/board/clients.
  it('runs the full cross-user cleanup when a foreground refresh fails', async () => {
    // A server-rejected refresh token is a confirmed logout → anonymous → cleanup.
    deduplicatedRefreshMock.mockResolvedValue({ status: 'rejected', generation: 1 });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'p-1', name: "User A's playlist" }]);
    queryClient.setQueryData(['activeBoard'], { uuid: 'b-a' });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    // First pass authenticates (token fresh); authStateRef then reads
    // isAuthenticated: true, which gates the heavy cleanup on the next checkAuth.
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    // Now the token is within the expiry window and the refresh fails — driven
    // via the exposed refreshAuthState (the same checkAuth AppState 'active' runs).
    isTokenExpiringSoonMock.mockResolvedValue(true);
    await act(async () => {
      await result.current.refreshAuthState();
    });

    // Same cleanup as the explicit signOut tests, minus authSignOut() — the
    // expiry path skips re-revoking an already-invalid token.
    expect(authSignOutMock).not.toHaveBeenCalled();
    expect(clearStoredSessionIdMock).toHaveBeenCalledTimes(1);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledTimes(1);
    expect(resetHttpClientMock).toHaveBeenCalledTimes(1);
    expect(disposeWsClientMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['userPlaylists'])).toBeUndefined();
    expect(queryClient.getQueryData(['activeBoard'])).toBeUndefined();
  });

  it('does not clean up a newer login when an old foreground refresh is superseded', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'new-user-playlist' }]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    let releaseRefresh!: (result: MockRefreshResult) => void;
    isTokenExpiringSoonMock.mockResolvedValue(true);
    deduplicatedRefreshMock.mockReturnValueOnce(
      new Promise<MockRefreshResult>((resolve) => {
        releaseRefresh = resolve;
      }),
    );
    const oldSessionCheck = result.current.refreshAuthState();
    await vi.waitFor(() => expect(deduplicatedRefreshMock).toHaveBeenCalled());
    // The generation flips before the stalled refresh resolves → superseded, so
    // this stale check must not clean up the newer login.
    isAuthCredentialGenerationCurrentMock.mockReturnValue(false);
    releaseRefresh({ status: 'refreshed', generation: 1 });

    await act(async () => {
      await oldSessionCheck;
    });
    expect(result.current.isAuthenticated).toBe(true);
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).not.toHaveBeenCalled();
    expect(disposeWsClientMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'new-user-playlist' }]);
  });

  // Relaunch guard: if the app is killed before the next user signs in, the
  // React Query cache is empty but the persisted board/session id survive. A
  // signed-out cold start must clear those so user B can't inherit user A's
  // stored board. The heavy in-memory cleanup stays gated behind the
  // authenticated transition (nothing to wipe on a cold start).
  it('clears persisted board/session on a signed-out cold start (relaunch guard)', async () => {
    getAuthTokenMock.mockResolvedValue(null);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    // Provider returns its <Redirect> branch (children never mount), so assert
    // via the mocks rather than a hook snapshot.
    render(wrapper({ children: null }));

    await waitFor(() => expect(clearStoredActiveBoardMock).toHaveBeenCalledTimes(1));
    expect(clearStoredSessionIdMock).toHaveBeenCalledTimes(1);
    expect(resetHttpClientMock).not.toHaveBeenCalled();
    expect(disposeWsClientMock).not.toHaveBeenCalled();
  });

  it('bounds a hung web cold-start cleanup so the loading gate still releases', async () => {
    platformState.OS = 'web';
    getAuthTokenMock.mockResolvedValue(null);
    clearStoredSessionIdMock.mockReturnValue(new Promise<void>(() => {}));
    const onReady = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider onReady={onReady}>{null}</AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 2000 });
    expect(clearStoredSessionIdMock).toHaveBeenCalledWith(null);
  });
});

describe('AuthProvider.checkAuth keychain read failure', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    clearStoredSessionIdMock.mockReset();
    clearStoredActiveBoardMock.mockReset();
    reportErrorMock.mockReset();
    redirectMock.mockReset();
    isTokenExpiringSoonMock.mockResolvedValue(false);
  });

  // Repro for A11-auth-onboarding-001: a locked-keychain launch makes
  // SecureStore.getItemAsync REJECT (not return null). Without a try/catch in
  // checkAuth the rejection escapes, isLoading never flips to false, onReady
  // never fires, and the splash screen hangs forever. The fix reports the read
  // failure and releases the native loading gate using the established
  // signed-out behavior.
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
    // The failure is surfaced rather than swallowed silently.
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith('/auth/login');
    expect(redirectMock).not.toHaveBeenCalledWith('/auth/session-unavailable');
  });

  // The catch branch must stay cleanup-free: a keychain read failure is
  // transient (auth is restored on the next AppState 'active' re-check), so
  // wiping a still-valid user's persisted board/session here would be a
  // regression. Only the genuine signed-out branches clear persisted stores.
  it('does not clear persisted stores when the token read rejects', async () => {
    getAuthTokenMock.mockRejectedValue(new Error('keychain locked'));
    const onReady = vi.fn();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider onReady={onReady}>{children}</AuthProvider>
      </QueryClientProvider>
    );

    render(wrapper({ children: null }));

    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
  });

  it('preserves native foreground keychain-failure behavior without confirmed-sign-out cleanup', async () => {
    getAuthTokenMock.mockResolvedValue('jwt-token');

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    getAuthTokenMock.mockRejectedValue(new Error('keychain locked'));
    redirectMock.mockReset();
    await act(async () => {
      await result.current.refreshAuthState();
    });

    expect(redirectMock).toHaveBeenCalledWith('/auth/login');
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
  });

  it('preserves an authenticated web UI during a transient session outage', async () => {
    platformState.OS = 'web';
    getAuthTokenMock.mockResolvedValue('jwt-token');

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    getAuthTokenMock.mockRejectedValue(new Error('network unavailable'));
    redirectMock.mockReset();
    await act(async () => {
      await result.current.refreshAuthState();
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('routes an unavailable web cold-start session to retry instead of login', async () => {
    platformState.OS = 'web';
    getAuthTokenMock.mockRejectedValue(new Error('network unavailable'));
    const onReady = vi.fn();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider onReady={onReady}>{null}</AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(redirectMock).toHaveBeenCalledWith('/auth/session-unavailable');
    expect(redirectMock).not.toHaveBeenCalledWith('/auth/login');
  });

  it('leaves the web retry route for login after confirming an anonymous session', async () => {
    platformState.OS = 'web';
    routerState.segments = ['auth', 'session-unavailable'];
    getAuthTokenMock.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(null);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    redirectMock.mockReset();
    await act(async () => {
      await result.current.refreshAuthState();
    });

    expect(redirectMock).toHaveBeenCalledWith('/auth/login');
    expect(redirectMock).not.toHaveBeenCalledWith('/auth/session-unavailable');
  });
});
