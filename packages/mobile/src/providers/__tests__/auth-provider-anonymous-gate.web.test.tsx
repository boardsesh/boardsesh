// @vitest-environment jsdom
//
// The WEB half of the anonymous gate. Vitest resolves `anonymous-auth-gate` to
// the native fork (it has no `.web` extension resolution), so this suite swaps
// in the web fork through `vi.mock` — and the fork-parity test in
// `lib/routing/__tests__/anonymous-auth-gate.test.ts` is what makes that
// substitution faithful.
//
// The mock surface below mirrors `auth-provider.test.tsx`: AuthProvider's static
// import graph reaches native modules that cannot load under vitest, so the
// stubs are load guards rather than behaviour. Deliberately a separate file —
// the native-parity suite next door must run against the REAL native fork, and
// a `vi.mock` in that file would hollow out the guarantee it exists to make.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

const redirectMock = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ OS: 'web' }));
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
const accessModeStoreMock = vi.hoisted(() => ({
  read: vi.fn(() => 'account' as const),
  write: vi.fn(),
  readLocalCatalogReady: vi.fn(() => false),
  writeLocalCatalogReady: vi.fn(),
}));

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

vi.mock('../../lib/access-mode-store', () => ({
  readPersistedAccessMode: () => accessModeStoreMock.read(),
  writePersistedAccessMode: (accessMode: 'account' | 'local') => accessModeStoreMock.write(accessMode),
  readPersistedLocalCatalogReady: () => accessModeStoreMock.readLocalCatalogReady(),
  writePersistedLocalCatalogReady: (isReady: boolean) => accessModeStoreMock.writeLocalCatalogReady(isReady),
  writePendingLocalProfileImportPrompt: vi.fn(),
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
  platformState.OS = 'web';
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
  accessModeStoreMock.read.mockClear();
  accessModeStoreMock.write.mockReset();
  accessModeStoreMock.readLocalCatalogReady.mockClear();
  accessModeStoreMock.writeLocalCatalogReady.mockReset();
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

vi.mock('../../lib/graphql/use-active-board', () => ({
  ACTIVE_BOARD_QUERY_KEY: ['activeBoard'] as const,
  clearStoredActiveBoardCoordinated: vi.fn(),
}));

// Another load guard: sign-out clears the self-heal's per-account validation
// cache, and the real module reaches storage this env doesn't provide. What
// sign-out actually does with it is asserted in `auth-provider.test.tsx`.
vi.mock('../../lib/boards/active-board-self-heal-validation-cache', () => ({
  resetActiveBoardSelfHealValidationCache: vi.fn(),
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
vi.mock('../../offline/offline-sync-adapter', () => ({
  drainMutationQueue: (...args: unknown[]) => drainMutationQueueMock(...args),
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
  getSetting: () => false,
  setSetting: (...args: unknown[]) => setSettingMock(...args),
  clearOfflineBoards: () => clearOfflineBoardsMock(),
  setSettingsAccessMode: vi.fn(),
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

// The whole point of this file: AuthProvider gets the fork the browser export
// gets. Re-exported wholesale so the substitution can't drift from the real one.
vi.mock('../../lib/routing/anonymous-auth-gate', async () => {
  return await import('../../lib/routing/anonymous-auth-gate.web');
});

import { AuthProvider } from '../auth-provider';
import { GATED_PATHS, READ_ONLY_PATHS } from '../../lib/routing/__tests__/read-only-route-corpus';

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

describe('AuthProvider anonymous read-only gate (web)', () => {
  beforeEach(() => {
    platformState.OS = 'web';
    getAuthTokenMock.mockReset();
    isTokenExpiringSoonMock.mockReset();
    isTokenExpiringSoonMock.mockResolvedValue(false);
    routerState.segments = [];
    window.history.replaceState({}, '', '/');
  });

  // The whole point of W-06: a climb link from the www front door renders for
  // someone who has never signed in, instead of bouncing them to a login wall
  // that forgets which climb they came for.
  it.each(READ_ONLY_PATHS)('renders the route tree for a signed-out visitor at %s', async (path) => {
    getAuthTokenMock.mockResolvedValue(null);
    window.history.replaceState({}, '', path);

    const { queryByTestId } = renderGate();

    await waitFor(() => expect(queryByTestId('child')).not.toBeNull());
    expect(redirectMock).not.toHaveBeenCalledWith('/auth/login');
  });

  it.each(GATED_PATHS)('still sends a signed-out visitor at %s to login', async (path) => {
    getAuthTokenMock.mockResolvedValue(null);
    window.history.replaceState({}, '', path);

    const { queryByTestId } = renderGate();

    // Exactly the bare route: the `?next=` is appended by the read-only route's
    // own hand-off, never by the gate.
    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('/auth/login'));
    expect(redirectMock).not.toHaveBeenCalledWith(expect.stringContaining('next='));
    expect(queryByTestId('child')).toBeNull();
  });

  it('lands a freshly signed-in visitor on the climb their next= names', async () => {
    const next = '/b/the-gym/40/view/crimpy-thing-0A1B2C3D4E5F60718293A4B5C6D7E8F9';
    getAuthTokenMock.mockResolvedValue('jwt-token');
    routerState.segments = ['auth', 'login'];
    window.history.replaceState({}, '', `/auth/login?next=${encodeURIComponent(next)}`);

    renderGate();

    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith(next));
    expect(redirectMock).not.toHaveBeenCalledWith('/(tabs)/home');
  });

  // The register branch of the same flow: login forwards `next` to the sign-up
  // screen as a router param, so someone who creates an account instead of
  // signing in lands on the climb too. The provider navigates in both cases —
  // `register.tsx` needs no change of its own.
  it('lands a freshly registered visitor on the climb their next= names', async () => {
    const next = '/b/the-gym/40/view/crimpy-thing-0A1B2C3D4E5F60718293A4B5C6D7E8F9';
    getAuthTokenMock.mockResolvedValue('jwt-token');
    routerState.segments = ['auth', 'register'];
    window.history.replaceState({}, '', `/auth/register?next=${encodeURIComponent(next)}`);

    renderGate();

    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith(next));
    expect(redirectMock).not.toHaveBeenCalledWith('/(tabs)/home');
  });

  it('drops a hostile next= and falls back to the home tab', async () => {
    getAuthTokenMock.mockResolvedValue('jwt-token');
    routerState.segments = ['auth', 'login'];
    window.history.replaceState({}, '', '/auth/login?next=//evil.example');

    renderGate();

    await waitFor(() => expect(redirectMock).toHaveBeenCalledWith('/(tabs)/home'));
    expect(redirectMock).not.toHaveBeenCalledWith(expect.stringContaining('evil.example'));
  });
});
