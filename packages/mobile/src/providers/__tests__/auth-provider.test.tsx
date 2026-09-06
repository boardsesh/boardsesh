// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, screen, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const redirectMock = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ OS: 'ios' }));
const routerState = vi.hoisted(() => ({ segments: [] as string[] }));
const appStateState = vi.hoisted(() => ({
  listener: null as ((nextAppState: string) => void) | null,
}));
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
const consumeWebOAuthReturnProviderMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const resetActiveBoardSelfHealValidationCacheMock = vi.hoisted(() => vi.fn());

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
    addEventListener: vi.fn((_event: string, listener: (nextAppState: string) => void) => {
      appStateState.listener = listener;
      return {
        remove: vi.fn(() => {
          if (appStateState.listener === listener) appStateState.listener = null;
        }),
      };
    }),
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
  appStateState.listener = null;
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
  consumeWebOAuthReturnProviderMock.mockReset();
  consumeWebOAuthReturnProviderMock.mockReturnValue(null);
  trackMock.mockReset();
  resetActiveBoardSelfHealValidationCacheMock.mockReset();
  reportHandledErrorMock.mockReset();
  onlineManager.setOnline(true);
  captureAuthCredentialGenerationMock.mockReset();
  captureAuthCredentialGenerationMock.mockReturnValue(1);
  authSignInWithCredentialsMock.mockReset();
  authSignInWithGoogleWebMock.mockReset();
  authSignInWithAppleWebMock.mockReset();
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
const reportHandledErrorMock = vi.fn();
vi.mock('../../lib/error-reporting', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
  reportHandledError: (...args: unknown[]) => reportHandledErrorMock(...args),
}));

const resetAnalyticsMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({
  reset: resetAnalyticsMock,
  track: (...args: unknown[]) => trackMock(...args),
}));

// Sign-out is about to DELETE the whole outbox (dead letters included). The
// gauge that measures it must run before resetAnalytics() or the event lands on
// an anonymous distinct_id — see the ordering test near the bottom of this file.
const reportOutboxDiscardedOnSignOutMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../../offline/outbox-telemetry', () => ({
  reportOutboxDiscardedOnSignOut: reportOutboxDiscardedOnSignOutMock,
}));

vi.mock('../../lib/oauth-pending-store', () => ({
  consumeFreshOAuthPending: (...args: unknown[]) => consumeFreshOAuthPendingMock(...args),
}));

vi.mock('../../lib/oauth-return', () => ({
  consumeWebOAuthReturn: (...args: unknown[]) => consumeWebOAuthReturnProviderMock(...args),
}));

const authSignOutMock = vi.fn();
const authRegisterMock = vi.fn();
const authSignInWithCredentialsMock = vi.fn();
const authSignInWithGoogleWebMock = vi.fn();
const authSignInWithAppleWebMock = vi.fn();
vi.mock('../../lib/auth', () => ({
  signInWithApple: vi.fn(),
  signInWithGoogle: vi.fn(),
  signInWithGoogleWeb: (...args: unknown[]) => authSignInWithGoogleWebMock(...args),
  signInWithAppleWeb: (...args: unknown[]) => authSignInWithAppleWebMock(...args),
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

const setOfflineModeMock = vi.fn();
// Spread the real module: the auth interceptor and auth-session read
// `getConnectivitySnapshot` from it, and a mock that only knows
// `setOfflineMode` would turn every checkAuth into a TypeError before the
// cleanup under test ever ran.
vi.mock('../../lib/connectivity/connectivity-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/connectivity/connectivity-store')>()),
  setOfflineMode: (enabled: boolean, source: string) => setOfflineModeMock(enabled, source),
}));

vi.mock('../../lib/graphql/use-active-board', () => ({
  ACTIVE_BOARD_QUERY_KEY: ['activeBoard'] as const,
  clearStoredActiveBoardCoordinated: (...args: unknown[]) => clearStoredActiveBoardMock(...args),
}));

vi.mock('../../lib/boards/active-board-self-heal-validation-cache', () => ({
  resetActiveBoardSelfHealValidationCache: () => resetActiveBoardSelfHealValidationCacheMock(),
}));

const getDatabaseHandleMock = vi.fn((): unknown => null);
// Two different wipes: the selective one (downloaded board catalogs kept) and the
// full one an explicit sign-out runs. Which one a given path picks is the regression
// guard of issue #3621, so both are recorded rather than stubbed anonymously.
const clearUserDataMock = vi.hoisted(() => vi.fn(async () => {}));
const purgeLocalDataForSignOutMock = vi.hoisted(() =>
  vi.fn(async () => ({ pendingDiscarded: 0, deadLettersDiscarded: 0, hadDownloads: false, vacuumed: true })),
);
vi.mock('../../db', () => ({
  getDatabaseHandle: () => getDatabaseHandleMock(),
  clearUserData: clearUserDataMock,
  purgeLocalDataForSignOut: purgeLocalDataForSignOutMock,
}));

const resetSyncStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../../sync/sync-status', () => ({ resetSyncStatus: resetSyncStatusMock }));

const drainMutationQueueMock = vi.fn(async (..._args: unknown[]) => {});
// The sign-out drain gate reads the WHOLE outbox, pending plus dead letters: a device
// holding only failed writes still has unsynced work this sign-out is about to delete.
type OutboxSummary = {
  pendingCount: number;
  deadLetterCount: number;
  oldestPendingAt: string | null;
  oldestDeadLetterAt: string | null;
};
function outbox(pendingCount: number, deadLetterCount = 0): OutboxSummary {
  return { pendingCount, deadLetterCount, oldestPendingAt: null, oldestDeadLetterAt: null };
}
const getOutboxSummaryMock = vi.fn(async (..._args: unknown[]): Promise<OutboxSummary> => outbox(0));
vi.mock('@boardsesh/offline-sync', () => ({
  getOutboxSummary: (...args: unknown[]) => getOutboxSummaryMock(...args),
  setSigningOut: vi.fn(),
}));
// The download funnel's sign-out terminal (issue #4452). The explicit wipe hands
// its reporter to purgeLocalDataForSignOut — only that transaction can still see
// the markers it is about to delete — while the selective paths report from the
// provider, next to the `syncEnabledBoards` reset that is what actually ends
// those downloads.
const reportScopeDownloadAbandonedOnSignOutMock = vi.hoisted(() => vi.fn());
vi.mock('../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: (...args: unknown[]) => drainMutationQueueMock(...args),
  reportScopeDownloadAbandonedOnSignOut: reportScopeDownloadAbandonedOnSignOutMock,
}));
const reportAbandonedDownloadsOnSignOutMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../../offline/abandoned-download-terminals', () => ({
  reportAbandonedDownloadsOnSignOut: reportAbandonedDownloadsOnSignOutMock,
}));
// The offline-usage rollup's suppression map is in-memory and not keyed by user,
// so the sign-out paths reset it (#4317) — otherwise a same-day account switch
// inherits the previous user's counters and the new user's first offline day
// silently never fires.
const resetOfflineUsageSignalMock = vi.hoisted(() => vi.fn());
vi.mock('../../offline/offline-usage-signal', () => ({
  resetOfflineUsageSignal: () => resetOfflineUsageSignalMock(),
}));

const stopTokenManagementMock = vi.fn(async () => {});
vi.mock('../../notifications', () => ({
  stopTokenManagement: (_unregister: unknown) => stopTokenManagementMock(),
}));

// The provider clears the per-user offline-boards setting on sign-out. Stub the
// settings barrel so the test's static graph never pulls react-native-mmkv (→ the
// react-native Flow entry, which Rolldown's collection scan can't parse under RN 0.86).
const setSettingMock = vi.hoisted(() => vi.fn());
const clearOfflineBoardsMock = vi.hoisted(() => vi.fn());
vi.mock('../../settings', () => ({
  setSetting: (...args: unknown[]) => setSettingMock(...args),
  clearOfflineBoards: () => clearOfflineBoardsMock(),
}));

// The provider registers its forced-sign-out cleanup against this lib-layer hook
// (and lazily imports ensureFreshToken in checkAuth). Record the register/clear
// calls so the lifecycle test can assert the contract.
const setOnForcedSignOutMock = vi.fn();
const ensureFreshTokenMock = vi.fn().mockResolvedValue(true);
type MockRefreshResult =
  | { status: 'refreshed'; generation: number }
  | { status: 'rejected'; generation: number }
  | { status: 'unavailable'; generation: number; error: unknown }
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
import { GATED_PATHS, READ_ONLY_PATHS } from '../../lib/routing/__tests__/read-only-route-corpus';

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
    setOfflineModeMock.mockReset();
    reportErrorMock.mockReset();
    redirectMock.mockReset();
    setSettingMock.mockReset();
    clearOfflineBoardsMock.mockReset();
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
    // Same auth boundary, same reason: the next user must not inherit the
    // previous one's offline-read rollup counters (#4317).
    expect(resetOfflineUsageSignalMock).toHaveBeenCalled();
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
    expect(resetActiveBoardSelfHealValidationCacheMock).toHaveBeenCalledTimes(1);
    expect(resetActiveBoardSelfHealValidationCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearStoredActiveBoardMock.mock.invocationCallOrder[0]!,
    );
    // Create-climb and session-recap drafts are wiped for account isolation
    // only on web. Native sign-out keeps its origin behavior and must not touch
    // these drafts, so this stays native-neutral when the PR ships via OTA.
    expect(clearAllCreateClimbDraftsMock).not.toHaveBeenCalled();
    expect(clearSessionCommentDraftMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).toHaveBeenCalledTimes(1);
    expect(disposeWsClientMock).toHaveBeenCalledTimes(1);
    // Offline mode gates the backend, so a phone left signed out with the switch
    // still on would show a login screen whose own sign-in request is blocked —
    // locked out by a setting that is no longer reachable (#4862).
    expect(setOfflineModeMock).toHaveBeenCalledWith(false, 'sign_out');
    // Shared-device privacy: the per-user offline selection AND the board snapshots
    // the offline picker replays (which carry board NAMES) must not survive into the
    // next account. Asserted, not left to code review.
    expect(setSettingMock).toHaveBeenCalledWith('syncEnabledBoards', []);
    expect(clearOfflineBoardsMock).toHaveBeenCalledTimes(1);
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
    getOutboxSummaryMock.mockResolvedValue(outbox(1));
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

describe('AuthProvider browser-fallback foreground checks', () => {
  beforeEach(() => {
    platformState.OS = 'android';
    getAuthTokenMock.mockReset();
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockReset();
    isTokenExpiringSoonMock.mockResolvedValue(false);
  });

  const createWrapper = (queryClient: QueryClient) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      );
    };

  it('subsumes an earlier suppressed active event into exactly the explicit success read', async () => {
    let finishFallback!: (result: { success: true }) => void;
    authSignInWithGoogleWebMock.mockReturnValue(
      new Promise((resolve) => {
        finishFallback = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeFallback = getAuthTokenMock.mock.calls.length;

    const fallbackPromise = result.current.signInWithGoogleWeb();
    await vi.waitFor(() => expect(authSignInWithGoogleWebMock).toHaveBeenCalledOnce());
    act(() => appStateState.listener?.('active'));
    await Promise.resolve();
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback);

    await act(async () => {
      finishFallback({ success: true });
      await fallbackPromise;
    });

    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback + 1);
  });

  it('defers an active event that arrives during the explicit success read until release', async () => {
    let finishFallback!: (result: { success: true }) => void;
    let finishExplicitAuthRead!: (token: string) => void;
    authSignInWithGoogleWebMock.mockReturnValue(
      new Promise((resolve) => {
        finishFallback = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeFallback = getAuthTokenMock.mock.calls.length;
    getAuthTokenMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishExplicitAuthRead = resolve;
        }),
    );

    const fallbackPromise = result.current.signInWithGoogleWeb();
    act(() => appStateState.listener?.('active'));
    act(() => finishFallback({ success: true }));
    await vi.waitFor(() => expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback + 1));

    act(() => appStateState.listener?.('active'));
    await act(async () => {
      finishExplicitAuthRead('jwt-token');
      await fallbackPromise;
    });

    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback + 2);
  });

  it.each([
    ['a cancelled fallback', { success: false, cancelled: true }],
    ['a timed-out fallback', { success: false, status: null, error: 'browser_timeout' }],
  ])('runs one deferred foreground check after %s releases', async (_description, fallbackResult) => {
    let finishFallback!: (result: typeof fallbackResult) => void;
    authSignInWithGoogleWebMock.mockReturnValue(
      new Promise((resolve) => {
        finishFallback = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeFallback = getAuthTokenMock.mock.calls.length;

    const fallbackPromise = result.current.signInWithGoogleWeb();
    act(() => appStateState.listener?.('active'));
    act(() => appStateState.listener?.('active'));
    await Promise.resolve();
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback);

    await act(async () => {
      finishFallback(fallbackResult);
      await fallbackPromise;
    });
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback + 1);
  });

  it('runs one deferred foreground check after a failed fallback releases', async () => {
    let failFallback!: (error: Error) => void;
    authSignInWithGoogleWebMock.mockReturnValue(
      new Promise((_resolve, reject) => {
        failFallback = reject;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeFallback = getAuthTokenMock.mock.calls.length;

    const fallbackPromise = result.current.signInWithGoogleWeb();
    act(() => appStateState.listener?.('active'));
    act(() => appStateState.listener?.('active'));
    await Promise.resolve();
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback);

    await act(async () => {
      failFallback(new Error('browser failed'));
      await expect(fallbackPromise).rejects.toThrow('browser failed');
    });
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallback + 1);
  });

  it('drops a deferred foreground check when the provider unmounts before cancellation settles', async () => {
    let finishFallback!: (result: { success: false; cancelled: true }) => void;
    authSignInWithGoogleWebMock.mockReturnValue(
      new Promise((resolve) => {
        finishFallback = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    const fallbackPromise = result.current.signInWithGoogleWeb();
    act(() => appStateState.listener?.('active'));
    await Promise.resolve();
    const authReadsBeforeUnmount = getAuthTokenMock.mock.calls.length;
    const sessionClearsBeforeUnmount = clearStoredSessionIdMock.mock.calls.length;
    const activeBoardClearsBeforeUnmount = clearStoredActiveBoardMock.mock.calls.length;
    const queueClearsBeforeUnmount = clearStoredQueueSnapshotMock.mock.calls.length;

    unmount();
    getAuthTokenMock.mockResolvedValue(null);
    await act(async () => {
      finishFallback({ success: false, cancelled: true });
      await fallbackPromise;
    });

    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeUnmount);
    expect(clearStoredSessionIdMock).toHaveBeenCalledTimes(sessionClearsBeforeUnmount);
    expect(clearStoredActiveBoardMock).toHaveBeenCalledTimes(activeBoardClearsBeforeUnmount);
    expect(clearStoredQueueSnapshotMock).toHaveBeenCalledTimes(queueClearsBeforeUnmount);
  });

  it('keeps active checks suppressed until all overlapping fallbacks finish', async () => {
    let finishGoogle!: (result: { success: false; cancelled: true }) => void;
    let finishApple!: (result: { success: false; cancelled: true }) => void;
    authSignInWithGoogleWebMock.mockReturnValue(
      new Promise((resolve) => {
        finishGoogle = resolve;
      }),
    );
    authSignInWithAppleWebMock.mockReturnValue(
      new Promise((resolve) => {
        finishApple = resolve;
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    const authReadsBeforeFallbacks = getAuthTokenMock.mock.calls.length;

    const googleFallback = result.current.signInWithGoogleWeb();
    const appleFallback = result.current.signInWithAppleWeb();
    await act(async () => {
      finishGoogle({ success: false, cancelled: true });
      await googleFallback;
    });
    act(() => appStateState.listener?.('active'));
    await Promise.resolve();
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallbacks);

    await act(async () => {
      finishApple({ success: false, cancelled: true });
      await appleFallback;
    });
    expect(getAuthTokenMock).toHaveBeenCalledTimes(authReadsBeforeFallbacks + 1);
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
    consumeWebOAuthReturnProviderMock.mockReturnValue({
      provider: 'apple',
      attemptId: 'attempt-apple-1',
      error: null,
    });
    consumeFreshOAuthPendingMock.mockResolvedValue({
      attemptId: 'attempt-apple-1',
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

  it('does not attribute a login when the OAuth return has no pending attempt', async () => {
    consumeWebOAuthReturnProviderMock.mockReturnValue({
      provider: 'google',
      attemptId: 'attempt-google-1',
      error: null,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    await waitFor(() => expect(consumeFreshOAuthPendingMock).toHaveBeenCalledTimes(1));
    expect(trackMock).not.toHaveBeenCalledWith(
      'Login Succeeded',
      expect.objectContaining({ auth_method: 'google', flow: 'web' }),
    );
  });
});

describe('AuthProvider.signOut mutation-queue drain gating', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    authSignOutMock.mockReset();
    getDatabaseHandleMock.mockReset();
    drainMutationQueueMock.mockReset();
    getOutboxSummaryMock.mockReset();
    setOfflineModeMock.mockReset();
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    authSignOutMock.mockResolvedValue(true);
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
    drainMutationQueueMock.mockResolvedValue(undefined);
    getOutboxSummaryMock.mockResolvedValue(outbox(0));
  });

  async function signOutWithQueueState(pendingCount: number, deadLetterCount = 0) {
    getDatabaseHandleMock.mockReturnValue({ tag: 'db' });
    getOutboxSummaryMock.mockResolvedValue(outbox(pendingCount, deadLetterCount));

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
    expect(getOutboxSummaryMock).toHaveBeenCalled();
    expect(drainMutationQueueMock).toHaveBeenCalledTimes(1);
  });

  // #4862. Offline mode holds `onlineManager` false, and the drainer returns on
  // its first `isOnline()` check — so a flip that only happened later, in
  // runSignedOutCleanup, would let `purgeLocalDataForSignOut` delete exactly the
  // writes the confirmation dialog promised to try and send. Ordering IS the fix.
  it('leaves offline mode before the drain runs, not after it', async () => {
    await signOutWithQueueState(3);

    expect(setOfflineModeMock).toHaveBeenCalledWith(false, 'sign_out');
    expect(drainMutationQueueMock).toHaveBeenCalledTimes(1);
    expect(setOfflineModeMock.mock.invocationCallOrder[0]!).toBeLessThan(
      getOutboxSummaryMock.mock.invocationCallOrder[0]!,
    );
    expect(setOfflineModeMock.mock.invocationCallOrder[0]!).toBeLessThan(
      drainMutationQueueMock.mock.invocationCallOrder[0]!,
    );
  });

  it('skips the drain entirely when the outbox is empty', async () => {
    await signOutWithQueueState(0);
    expect(getOutboxSummaryMock).toHaveBeenCalled();
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });

  // Dead letters can't be pushed by the drainer, but they ARE unsynced work this
  // sign-out is about to delete. Gating on `status = 'pending'` alone let a device
  // whose whole outbox had dead-lettered report an empty queue, which is the same
  // blind spot the confirmation dialog had.
  it('still enters the drain when only dead letters are queued', async () => {
    await signOutWithQueueState(0, 2);
    expect(getOutboxSummaryMock).toHaveBeenCalled();
    expect(drainMutationQueueMock).toHaveBeenCalledTimes(1);
  });

  it('skips both counts and the drain when there is no local database', async () => {
    getDatabaseHandleMock.mockReturnValue(null);
    getOutboxSummaryMock.mockResolvedValue(outbox(5, 5));

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

    expect(getOutboxSummaryMock).not.toHaveBeenCalled();
    expect(drainMutationQueueMock).not.toHaveBeenCalled();
  });

  // Issue #4315. clearUserData DELETEs pending_mutations wholesale, and the
  // best-effort drain above skips dead letters entirely (getPendingCount filters
  // status = 'pending'), so this gauge is the only record that those writes
  // existed. The ordering is the whole correctness of it: after
  // resetAnalytics() the event carries an anonymous distinct_id and can never be
  // joined back to the account that lost them.
  it('measures the outbox before resetting analytics', async () => {
    resetAnalyticsMock.mockClear();
    reportOutboxDiscardedOnSignOutMock.mockClear();

    await signOutWithQueueState(0);

    expect(reportOutboxDiscardedOnSignOutMock).toHaveBeenCalledWith({ tag: 'db' });
    expect(resetAnalyticsMock).toHaveBeenCalled();
    const gaugeOrder = reportOutboxDiscardedOnSignOutMock.mock.invocationCallOrder[0];
    const resetOrder = resetAnalyticsMock.mock.invocationCallOrder[0];
    expect(gaugeOrder).toBeLessThan(resetOrder);
  });

  it('skips the gauge when there is no local database', async () => {
    reportOutboxDiscardedOnSignOutMock.mockClear();
    getDatabaseHandleMock.mockReturnValue(null);

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

    expect(reportOutboxDiscardedOnSignOutMock).not.toHaveBeenCalled();
  });
});

// Issue #3621. An explicit sign-out deletes the downloaded board catalogs; every
// other signed-out path keeps them. Getting that split wrong in either direction is
// a user-visible bug — one leaves a 271MB orphan on the phone, the other eats it on
// a token-refresh glitch — so each path asserts WHICH wipe it ran, not just that it
// cleaned up.
describe('AuthProvider sign-out offline data wipe', () => {
  beforeEach(() => {
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    authSignOutMock.mockReset();
    getDatabaseHandleMock.mockReset();
    clearUserDataMock.mockClear();
    purgeLocalDataForSignOutMock.mockClear();
    purgeLocalDataForSignOutMock.mockResolvedValue({
      pendingDiscarded: 0,
      deadLettersDiscarded: 0,
      hadDownloads: false,
      vacuumed: true,
    });
    resetSyncStatusMock.mockClear();
    resetAnalyticsMock.mockClear();
    setSettingMock.mockClear();
    trackMock.mockClear();
    reportScopeDownloadAbandonedOnSignOutMock.mockClear();
    reportAbandonedDownloadsOnSignOutMock.mockClear();
    drainMutationQueueMock.mockReset();
    getOutboxSummaryMock.mockReset();
    setOnForcedSignOutMock.mockReset();
    deduplicatedRefreshMock.mockReset();
    deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 });
    getAuthTokenMock.mockResolvedValue('jwt-token');
    isTokenExpiringSoonMock.mockResolvedValue(false);
    authSignOutMock.mockResolvedValue(true);
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
    getOutboxSummaryMock.mockResolvedValue(outbox(0));
    getDatabaseHandleMock.mockReturnValue({ tag: 'db' });
  });

  async function renderSignedIn() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    return result;
  }

  it('wipes the downloaded catalogs on an explicit sign-out', async () => {
    const result = await renderSignedIn();

    await act(async () => {
      await result.current.signOut();
    });

    expect(purgeLocalDataForSignOutMock).toHaveBeenCalledTimes(1);
    expect(clearUserDataMock).not.toHaveBeenCalled();
  });

  it('wipes the downloaded catalogs when the account is deleted', async () => {
    const result = await renderSignedIn();

    await act(async () => {
      await result.current.signOut('account_deleted');
    });

    expect(purgeLocalDataForSignOutMock).toHaveBeenCalledTimes(1);
    expect(clearUserDataMock).not.toHaveBeenCalled();
  });

  // The guard that matters most: a failed token refresh is not a decision the user
  // made, so it must never cost them a download they waited minutes for.
  it('keeps the downloaded catalogs when a 401 forces a sign-out', async () => {
    await renderSignedIn();
    await waitFor(() => expect(setOnForcedSignOutMock).toHaveBeenCalled());
    const forceSignOut = setOnForcedSignOutMock.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    expect(typeof forceSignOut).toBe('function');

    await act(async () => {
      forceSignOut?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(clearUserDataMock).toHaveBeenCalled());

    expect(purgeLocalDataForSignOutMock).not.toHaveBeenCalled();
  });

  it('keeps the downloaded catalogs when checkAuth finds the session expired', async () => {
    const result = await renderSignedIn();

    deduplicatedRefreshMock.mockResolvedValue({ status: 'rejected', generation: 1 });
    isTokenExpiringSoonMock.mockResolvedValue(true);
    await act(async () => {
      await result.current.refreshAuthState();
    });

    expect(clearUserDataMock).toHaveBeenCalled();
    expect(purgeLocalDataForSignOutMock).not.toHaveBeenCalled();
  });

  // Dead letters ride along as their own count rather than being folded into
  // pendingDiscarded: they are deleted here too, but nothing tried to send them.
  it('reports what the wipe actually removed, once', async () => {
    purgeLocalDataForSignOutMock.mockResolvedValue({
      pendingDiscarded: 4,
      deadLettersDiscarded: 2,
      hadDownloads: true,
      vacuumed: true,
    });
    const result = await renderSignedIn();

    await act(async () => {
      await result.current.signOut();
    });

    const wipeEvents = trackMock.mock.calls.filter((call) => call[0] === 'Offline Data Wiped On Sign Out');
    expect(wipeEvents).toHaveLength(1);
    expect(wipeEvents[0][1]).toMatchObject({
      pendingDiscarded: 4,
      deadLettersDiscarded: 2,
      hadDownloads: true,
      vacuumed: true,
    });
  });

  it('does not report the wipe on a path that kept the catalogs', async () => {
    const result = await renderSignedIn();

    deduplicatedRefreshMock.mockResolvedValue({ status: 'rejected', generation: 1 });
    isTokenExpiringSoonMock.mockResolvedValue(true);
    await act(async () => {
      await result.current.refreshAuthState();
    });

    expect(trackMock.mock.calls.some((call) => call[0] === 'Offline Data Wiped On Sign Out')).toBe(false);
  });

  // Issue #4452. Production showed every `Offline Data Wiped On Sign Out` landing
  // on a DIFFERENT person_id from the `Logout` half a second earlier, because
  // resetAnalytics() ran first — so the wipe's own event, and every download
  // terminal emitted beside it, arrived on a fresh anonymous distinct_id that no
  // funnel query can pair with its `Offline Board Download Started`.
  it('tracks the wipe before resetting analytics, not after', async () => {
    purgeLocalDataForSignOutMock.mockResolvedValue({
      pendingDiscarded: 0,
      deadLettersDiscarded: 0,
      hadDownloads: true,
      vacuumed: true,
    });
    const result = await renderSignedIn();

    await act(async () => {
      await result.current.signOut();
    });

    const wipeCall = trackMock.mock.calls.findIndex((call) => call[0] === 'Offline Data Wiped On Sign Out');
    expect(wipeCall).toBeGreaterThanOrEqual(0);
    expect(resetAnalyticsMock).toHaveBeenCalled();
    expect(trackMock.mock.invocationCallOrder[wipeCall]).toBeLessThan(resetAnalyticsMock.mock.invocationCallOrder[0]);
  });

  // The wipe is the only code that can still see the `scope-started:` markers its
  // own transaction is about to delete, so the terminal has to be reported from
  // inside it rather than from here.
  it('hands the explicit wipe the download-abandoned reporter', async () => {
    const result = await renderSignedIn();

    await act(async () => {
      await result.current.signOut();
    });

    expect(purgeLocalDataForSignOutMock).toHaveBeenCalledWith(
      { tag: 'db' },
      { onDownloadAbandoned: reportScopeDownloadAbandonedOnSignOutMock },
    );
    // The selective sweep would double-report what the wipe already reported —
    // and the markers are gone by then anyway.
    expect(reportAbandonedDownloadsOnSignOutMock).not.toHaveBeenCalled();
  });

  // The selective sign-outs delete nothing and keep every marker, so nothing in
  // the wipe can report for them — but `setSetting('syncEnabledBoards', [])` runs
  // on these paths too, and pullSync only ever visits enabled scopes, so the
  // download is over just the same.
  it('closes the download funnel on a sign-out that kept the catalogs', async () => {
    const result = await renderSignedIn();

    deduplicatedRefreshMock.mockResolvedValue({ status: 'rejected', generation: 1 });
    isTokenExpiringSoonMock.mockResolvedValue(true);
    await act(async () => {
      await result.current.refreshAuthState();
    });

    expect(reportAbandonedDownloadsOnSignOutMock).toHaveBeenCalledWith({ tag: 'db' });
    // Order is the whole correctness of it, on both sides: after resetAnalytics()
    // the terminal is unjoinable, and after the enabled-set reset there is no way
    // to tell which boards were downloading.
    const reportOrder = reportAbandonedDownloadsOnSignOutMock.mock.invocationCallOrder[0];
    expect(reportOrder).toBeLessThan(resetAnalyticsMock.mock.invocationCallOrder[0]);
    const enabledBoardsReset = setSettingMock.mock.calls.findIndex((call) => call[0] === 'syncEnabledBoards');
    expect(enabledBoardsReset).toBeGreaterThanOrEqual(0);
    expect(reportOrder).toBeLessThan(setSettingMock.mock.invocationCallOrder[enabledBoardsReset]);
  });

  // A wedged SQLite file must not strand someone in a half-signed-out app.
  it('completes the sign-out even when the wipe throws', async () => {
    purgeLocalDataForSignOutMock.mockRejectedValue(new Error('database is locked'));
    const result = await renderSignedIn();

    await act(async () => {
      await expect(result.current.signOut()).resolves.toBeUndefined();
    });

    expect(setSettingMock).toHaveBeenCalledWith('syncEnabledBoards', []);
  });

  // "Last synced 5 minutes ago" belonged to the account that just left.
  it('resets the sync status so the next account starts from never-synced', async () => {
    const result = await renderSignedIn();

    await act(async () => {
      await result.current.signOut();
    });

    expect(resetSyncStatusMock).toHaveBeenCalled();
  });

  it('drains the queue exactly once per sign-out', async () => {
    getOutboxSummaryMock.mockResolvedValue(outbox(2));
    drainMutationQueueMock.mockResolvedValue(undefined);
    const result = await renderSignedIn();

    await act(async () => {
      await result.current.signOut();
    });

    expect(drainMutationQueueMock).toHaveBeenCalledTimes(1);
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
    expect(resetActiveBoardSelfHealValidationCacheMock).toHaveBeenCalledOnce();
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

describe('AuthProvider native degraded sessions', () => {
  const refreshUnavailableError = new Error('Network request failed');

  beforeEach(() => {
    getAuthTokenMock.mockReset();
    getAuthTokenMock.mockResolvedValue('old-jwt');
    isTokenExpiringSoonMock.mockReset();
    isTokenExpiringSoonMock.mockResolvedValue(true);
    deduplicatedRefreshMock.mockReset();
    deduplicatedRefreshMock.mockResolvedValue({
      status: 'unavailable',
      generation: 1,
      error: refreshUnavailableError,
    });
    clearStoredSessionIdMock.mockReset();
    clearStoredSessionIdMock.mockResolvedValue(undefined);
    clearStoredActiveBoardMock.mockReset();
    clearStoredActiveBoardMock.mockResolvedValue(undefined);
    resetHttpClientMock.mockReset();
    disposeWsClientMock.mockReset();
    redirectMock.mockReset();
    reportErrorMock.mockReset();
    reportHandledErrorMock.mockReset();
  });

  const createWrapper = (queryClient: QueryClient) =>
    function NativeAuthWrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      );
    };

  it('keeps an expiring-token cold start authenticated when refresh is offline', async () => {
    onlineManager.setOnline(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    expect(deduplicatedRefreshMock).toHaveBeenCalledOnce();
    expect(getAuthTokenMock).toHaveBeenCalledOnce();
    expect(redirectMock).not.toHaveBeenCalledWith('/auth/login');
    expect(redirectMock).not.toHaveBeenCalledWith('/auth/session-unavailable');
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    // The interceptor owns refresh-unavailable reporting with the original
    // transport error; the provider must not emit duplicate generic noise.
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });

  it('keeps screenshot-mode follow-up token-read failures on the native login path', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const keychainError = new Error('screenshot keychain relocked');
    getAuthTokenMock.mockResolvedValueOnce(null).mockRejectedValueOnce(keychainError);
    authSignInWithCredentialsMock.mockResolvedValue({ success: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{null}</AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('/auth/login'));
    expect(redirectMock).not.toHaveBeenCalledWith('/auth/session-unavailable');
    expect(reportHandledErrorMock).toHaveBeenCalledWith(keychainError, {
      tags: { source: 'auth-session', auth_stage: 'token-read' },
    });
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
  });

  it('preserves the authenticated foreground tree and caches during an unavailable refresh', async () => {
    isTokenExpiringSoonMock.mockResolvedValue(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userPlaylists'], [{ id: 'offline-playlist' }]);
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    isTokenExpiringSoonMock.mockResolvedValue(true);
    redirectMock.mockReset();
    await act(async () => {
      await result.current.refreshAuthState();
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['userPlaylists'])).toEqual([{ id: 'offline-playlist' }]);
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).not.toHaveBeenCalled();
    expect(disposeWsClientMock).not.toHaveBeenCalled();
  });

  it('revalidates once on reconnect only while the native session is degraded', async () => {
    onlineManager.setOnline(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(deduplicatedRefreshMock).toHaveBeenCalledOnce();

    deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 });
    await act(async () => {
      onlineManager.setOnline(true);
      await vi.waitFor(() => expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2));
    });

    // A clean result removes the reconnect subscription. Later network changes
    // must not create an auth refresh storm for an ordinary authenticated session.
    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await Promise.resolve();
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('revalidates and upgrades a degraded native session when the app becomes active', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(deduplicatedRefreshMock).toHaveBeenCalledOnce();
    expect(appStateState.listener).not.toBeNull();

    deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 });
    await act(async () => {
      appStateState.listener?.('active');
      await vi.waitFor(() => expect(getAuthTokenMock).toHaveBeenCalledTimes(3));
    });

    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2);
    expect(result.current.isAuthenticated).toBe(true);
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();

    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await Promise.resolve();
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces connectivity flaps and unsubscribes after unmount', async () => {
    onlineManager.setOnline(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    let releaseReconnect!: (result: MockRefreshResult) => void;
    deduplicatedRefreshMock.mockReturnValueOnce(
      new Promise<MockRefreshResult>((resolve) => {
        releaseReconnect = resolve;
      }),
    );
    act(() => onlineManager.setOnline(true));
    await vi.waitFor(() => expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2));

    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseReconnect({ status: 'unavailable', generation: 1, error: refreshUnavailableError });
      await Promise.resolve();
    });
    unmount();
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2);
  });

  it('retries after consecutive reconnect failures and stops once the session is clean', async () => {
    onlineManager.setOnline(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(deduplicatedRefreshMock).toHaveBeenCalledOnce();

    await act(async () => {
      onlineManager.setOnline(true);
      await vi.waitFor(() => expect(getAuthTokenMock).toHaveBeenCalledTimes(2));
      await Promise.resolve();
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(2);
    expect(result.current.isAuthenticated).toBe(true);

    deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 });
    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await vi.waitFor(() => expect(getAuthTokenMock).toHaveBeenCalledTimes(4));
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(3);
    expect(result.current.isAuthenticated).toBe(true);

    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await Promise.resolve();
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(3);
  });

  it('lets a rejected reconnect refresh run the normal signed-out cleanup', async () => {
    onlineManager.setOnline(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(deduplicatedRefreshMock).toHaveBeenCalledOnce());

    deduplicatedRefreshMock.mockResolvedValue({ status: 'rejected', generation: 1 });
    act(() => onlineManager.setOnline(true));

    await waitFor(() => expect(clearStoredSessionIdMock).toHaveBeenCalledOnce());
    expect(clearStoredActiveBoardMock).toHaveBeenCalledOnce();
    expect(resetHttpClientMock).toHaveBeenCalledOnce();
    expect(disposeWsClientMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/auth/login');
  });

  it('reports expiry-read degradation once through handled telemetry', async () => {
    const expiryReadError = new Error('expiry keychain read failed');
    isTokenExpiringSoonMock.mockRejectedValue(expiryReadError);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    expect(reportHandledErrorMock).toHaveBeenCalledWith(expiryReadError, {
      tags: { source: 'auth-session', auth_stage: 'expiry-read' },
    });
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('drops a resolved native session when its generation is stale at the provider boundary', async () => {
    isTokenExpiringSoonMock.mockResolvedValue(false);
    isAuthCredentialGenerationCurrentMock
      .mockReturnValueOnce(true) // after the initial JWT read
      .mockReturnValueOnce(true) // after the expiry read
      .mockReturnValueOnce(true) // immediately before resolveAuthSession returns
      .mockReturnValueOnce(false) // provider application boundary
      .mockReturnValue(true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{null}</AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('/auth/login'));
    expect(clearStoredSessionIdMock).not.toHaveBeenCalled();
    expect(clearStoredActiveBoardMock).not.toHaveBeenCalled();
    expect(resetHttpClientMock).not.toHaveBeenCalled();
    expect(disposeWsClientMock).not.toHaveBeenCalled();
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
    const keychainError = new Error('keychain locked');
    getAuthTokenMock.mockRejectedValue(keychainError);
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
    expect(reportHandledErrorMock).toHaveBeenCalledWith(keychainError, {
      tags: { source: 'auth-session', auth_stage: 'token-read' },
    });
    expect(reportErrorMock).not.toHaveBeenCalled();
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

// The native half of W-06's "web only" claim. Every merge to `main` touching
// `packages/mobile/**` auto-publishes a production OTA, and a JS-only diff keeps
// the same `fingerprint` runtimeVersion — so this relaxation lands on every
// installed binary whether or not it is meant for them. Byte-equality of this
// file is impossible (it gained a condition), so the equivalent is asserted
// here: under `Platform.OS = 'ios'` the gate emits exactly the redirect it
// emitted before, for the entire route corpus, and never renders children to a
// signed-out visitor.
describe('native auth gate parity (this PR auto-OTAs to the store fleet)', () => {
  beforeEach(() => {
    platformState.OS = 'ios';
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    isTokenExpiringSoonMock.mockResolvedValue(false);
  });

  function renderGate() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <span data-testid="child">app tree</span>
        </AuthProvider>
      </QueryClientProvider>,
    );
  }

  it.each([...READ_ONLY_PATHS, ...GATED_PATHS])(
    'redirects a signed-out visitor at %s to the bare login route',
    async (path) => {
      getAuthTokenMock.mockResolvedValue(null);
      routerState.segments = [];
      window.history.replaceState({}, '', path);

      const { queryByTestId } = renderGate();

      await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('/auth/login'));
      // No `?next=` on native: the query is a web-fork product, and the gate
      // itself never appends one on either platform.
      expect(redirectMock).not.toHaveBeenCalledWith(expect.stringContaining('next='));
      // And the tree below the gate stays withheld — a relaxed route on native
      // would show up here first.
      expect(queryByTestId('child')).toBeNull();
    },
  );

  it('ignores a next= in the address bar on the authenticated branch', async () => {
    const next = '/b/the-gym/40/view/0A1B2C3D4E5F60718293A4B5C6D7E8F9';
    getAuthTokenMock.mockResolvedValue('jwt-token');
    routerState.segments = ['auth', 'login'];
    window.history.replaceState({}, '', `/auth/login?next=${encodeURIComponent(next)}`);

    renderGate();

    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('/(tabs)/home'));
    expect(redirectMock).not.toHaveBeenCalledWith(next);
    expect(redirectMock).not.toHaveBeenCalledWith(expect.stringContaining('next='));
  });
});
