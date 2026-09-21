// @vitest-environment jsdom
//
// #5654: the four launch gates sat frozen at "not ready" from 2.2.0 on, because
// they are mounted inside <DatabaseProvider> and expo-sqlite's SQLiteProvider is
// memo()'d with a comparator that ignores `children`. `RootLayout` re-rendered
// when auth and fonts resolved, and the re-render stopped at that memo: every
// `ready={authReady && fontsReady}` below it kept its first-render `false`.
//
// No test caught it because every gate suite rendered its gate directly. This
// one renders the REAL DatabaseProvider around the REAL gates, over a stand-in
// for SQLiteProvider that keeps expo-sqlite's memo comparator verbatim (checked
// against the installed package below), and flips readiness the way RootLayout
// does: from state owned ABOVE the provider.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const sqliteCtrl = vi.hoisted(() => ({ opened: 0 }));
const connectivityBannerHookMock = vi.hoisted(() => vi.fn());
const trackGateMock = vi.hoisted(() => vi.fn());
const decideQaGateMock = vi.hoisted(() => vi.fn());
const decideSendRecoveryMock = vi.hoisted(() => vi.fn());
// Flag resolution as a tiny external store, so flipping it re-renders the
// consumers the way the real context does, from inside the memo'd subtree.
const flagsCtrl = vi.hoisted(() => ({
  resolved: true,
  listeners: new Set<() => void>(),
  setResolved(resolved: boolean) {
    flagsCtrl.resolved = resolved;
    for (const listener of flagsCtrl.listeners) listener();
  },
  subscribe(listener: () => void) {
    flagsCtrl.listeners.add(listener);
    return () => flagsCtrl.listeners.delete(listener);
  },
}));

// A faithful SQLiteProvider: `SQLiteProviderNonSuspense`'s open → onInit →
// render-children shape, wrapped in the same memo comparator expo-sqlite ships
// (build/hooks.js). The comparator is the whole point, so it is copied, not
// simplified; `expo-sqlite still freezes children` below fails if upstream
// changes it.
vi.mock('expo-sqlite', async () => {
  const {
    createContext,
    createElement,
    memo,
    useContext,
    useEffect,
    useRef,
    useState: useProviderState,
  } = await import('react');
  const SQLiteContext = createContext<unknown>(null);

  function deepEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (left == null || right == null) return false;
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    return (
      Object.keys(leftRecord).length === Object.keys(rightRecord).length &&
      Object.keys(leftRecord).every((key) => deepEqual(leftRecord[key], rightRecord[key]))
    );
  }

  type ProviderProps = {
    databaseName: string;
    directory?: string;
    options?: unknown;
    assetSource?: unknown;
    onInit?: (database: never) => Promise<void>;
    onError?: (error: Error) => void;
    useSuspense?: boolean;
    children?: ReactNode;
  };

  function SQLiteProviderNonSuspense({ databaseName, onInit, children }: ProviderProps) {
    const databaseRef = useRef<unknown>(null);
    const [loading, setLoading] = useProviderState(true);
    useEffect(() => {
      async function setup(): Promise<void> {
        sqliteCtrl.opened += 1;
        const database = { name: databaseName, closeAsync: async (): Promise<void> => {} };
        await onInit?.(database as never);
        databaseRef.current = database;
        setLoading(false);
      }
      void setup();
      return () => {
        databaseRef.current = null;
        setLoading(true);
      };
    }, [databaseName, onInit]);
    if (loading || databaseRef.current === null) return null;
    return createElement(SQLiteContext.Provider, { value: databaseRef.current }, children);
  }

  const SQLiteProvider = memo(
    function SQLiteProvider({ children, onError, useSuspense = false, ...props }: ProviderProps) {
      void useSuspense;
      return createElement(SQLiteProviderNonSuspense, { ...props, onError, children });
    },
    (prevProps: ProviderProps, nextProps: ProviderProps) =>
      prevProps.databaseName === nextProps.databaseName &&
      deepEqual(prevProps.options, nextProps.options) &&
      deepEqual(prevProps.assetSource, nextProps.assetSource) &&
      prevProps.directory === nextProps.directory &&
      prevProps.onInit === nextProps.onInit &&
      prevProps.onError === nextProps.onError &&
      prevProps.useSuspense === nextProps.useSuspense,
  );

  return { SQLiteProvider, useSQLiteContext: () => useContext(SQLiteContext) };
});

// DatabaseProvider's own collaborators. Its setup sequence is covered in
// database-provider*.test.tsx; here it only has to succeed.
vi.mock('../../db', () => ({
  DATABASE_NAME: 'boardsesh.db',
  initializeDatabase: vi.fn(async () => {}),
  releaseDatabaseHandle: vi.fn(),
}));
vi.mock('../../db/connection-retention', () => ({ retainDatabaseConnection: vi.fn(async () => null) }));
vi.mock('../../db/connection-pin', () => ({ pinDatabase: vi.fn() }));
vi.mock('../../db/reopen', () => ({ openReplacementDatabase: vi.fn() }));
vi.mock('../../db/connection', () => ({ registerReplacementOpener: vi.fn(), getDatabaseHandle: () => null }));
vi.mock('../../db/use-offline-schema-ready', () => ({ useOfflineSchemaReady: () => true }));

// What the gates read besides readiness. Each is set to the state that lets a
// gate get as far as its own decision, which is what the assertions look for.
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  InteractionManager: {
    runAfterInteractions: (task: () => void) => {
      task();
      return { cancel: () => {} };
    },
  },
  AccessibilityInfo: { announceForAccessibility: () => {} },
  Pressable: () => null,
  View: () => null,
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: () => null },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() }, useSegments: () => ['(tabs)', 'climbs'] }));
vi.mock('expo-linking', () => ({ getInitialURL: vi.fn(async () => null) }));
vi.mock('expo-updates', () => ({ updateId: null }));
vi.mock('@boardsesh/offline-sync', () => ({
  readDeadLetterRecoveryNotice: vi.fn(async () => null),
  clearDeadLetterRecoveryNotice: vi.fn(async () => {}),
}));
vi.mock('../../components/Text', () => ({ Text: () => null }));
vi.mock('../../components/Icon', () => ({ Icon: () => null }));
vi.mock('../../components/Button', () => ({ Button: () => null }));
vi.mock('../../components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../components/board-look/BoardLookStepGate', () => ({ BoardLookStepGate: () => null }));
vi.mock('../../components/connectivity/use-connectivity-banner', () => ({
  useConnectivityBanner: connectivityBannerHookMock,
}));
vi.mock('../theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {}, colorScheme: 'light' }),
}));
vi.mock('../auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../feature-flags-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useConnectivityBannerEnabled: () => true,
    useQaTesterGateEnabled: () => true,
    useSendRecoveryGateEnabled: () => true,
    useFeatureFlagsResolved: () => useSyncExternalStore(flagsCtrl.subscribe, () => flagsCtrl.resolved),
  };
});
vi.mock('../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ connectivityBannerBottom: 0 }),
}));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../lib/connectivity-banner-inset-store', () => ({ publishConnectivityBannerHeight: vi.fn() }));
vi.mock('../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 0 }),
  borderRadius: new Proxy({}, { get: () => 0 }),
}));
vi.mock('../../lib/onboarding/onboarding-storage', () => ({
  hasSeenOnboarding: vi.fn(async () => false),
  markOnboardingSeen: vi.fn(async () => {}),
}));
vi.mock('../../lib/onboarding/onboarding-gate-analytics', () => ({ trackOnboardingGateEvaluated: trackGateMock }));
// A finished read with no one in it, so the onboarding gate's profile wait is over.
vi.mock('../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: null, isFetching: false, isSuccess: true, isError: false }),
}));
vi.mock('../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null, isSuccess: true }) }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../lib/ota-branch-surfing-state', () => ({
  useOtaBranchSurfingState: () => ({ surfingBuild: false, ready: true }),
}));
vi.mock('../../settings', () => ({ getSetting: () => null, setSetting: vi.fn() }));
vi.mock('../../lib/qa/qa-surf', () => ({ listPrBranches: vi.fn(async () => []), readRunningPrNumber: () => null }));
vi.mock('../../lib/qa/qa-gate-decision', () => ({ decideQaGate: decideQaGateMock }));
vi.mock('../../lib/offline-recovery/send-recovery-decision', () => ({ decideSendRecovery: decideSendRecoveryMock }));

import { DatabaseProvider } from '../database-provider';
import { LaunchReadyProvider } from '../launch-ready-context';
import { ConnectivityBanner } from '../../components/connectivity/ConnectivityBanner';
import { OnboardingGate, resetOnboardingGateProcessForTests } from '../../components/onboarding/OnboardingGate';
import { QaTesterGate, resetQaGateSessionForTests } from '../../components/qa/QaTesterGate';
import { SendRecoveryGate, resetSendRecoverySessionForTests } from '../../components/offline/SendRecoveryGate';

/** Stands in for RootLayout: owns readiness as state, ABOVE the database provider. */
let setRootReady: (ready: boolean) => void = () => {};

function RootLayoutStandIn({ children }: { children: (ready: boolean) => ReactNode }) {
  const [ready, setReady] = useState(false);
  setRootReady = setReady;
  return <>{children(ready)}</>;
}

async function flipReady(): Promise<void> {
  await act(async () => {
    setRootReady(true);
  });
}

beforeEach(() => {
  sqliteCtrl.opened = 0;
  resetOnboardingGateProcessForTests();
  resetQaGateSessionForTests();
  resetSendRecoverySessionForTests();
  connectivityBannerHookMock.mockReset().mockReturnValue({
    state: { kind: 'hidden' },
    dismiss: () => {},
    expand: () => {},
    retry: () => {},
    stayOffline: () => {},
    goOnline: () => {},
    openSyncIssues: () => {},
  });
  trackGateMock.mockReset();
  flagsCtrl.resolved = true;
  flagsCtrl.listeners.clear();
  decideQaGateMock.mockReset().mockImplementation((input: { ready: boolean }) => (input.ready ? 'none' : 'wait'));
  decideSendRecoveryMock.mockReset().mockImplementation((input: { ready: boolean }) => (input.ready ? 'none' : 'wait'));
});

afterEach(() => {
  cleanup();
});

describe('expo-sqlite still freezes children', () => {
  it('ships the memo comparator this suite stands in for, and it never looks at children', () => {
    // If upstream starts comparing `children`, the freeze is gone and this whole
    // suite (and the warning in database-provider.tsx) needs a second look.
    const packageJsonPath = createRequire(import.meta.url).resolve('expo-sqlite/package.json');
    const hooksSource = readFileSync(join(dirname(packageJsonPath), 'build', 'hooks.js'), 'utf8');
    const normalized = hooksSource.replace(/\s+/g, ' ');

    expect(normalized).toContain('export const SQLiteProvider = memo(function SQLiteProvider(');
    const comparator =
      '(prevProps, nextProps) => prevProps.databaseName === nextProps.databaseName && ' +
      'deepEqual(prevProps.options, nextProps.options) && ' +
      'deepEqual(prevProps.assetSource, nextProps.assetSource) && ' +
      'prevProps.directory === nextProps.directory && ' +
      'prevProps.onInit === nextProps.onInit && ' +
      'prevProps.onError === nextProps.onError && ' +
      'prevProps.useSuspense === nextProps.useSuspense);';
    expect(normalized).toContain(comparator);
  });

  // The old wiring, in miniature: a prop computed from the parent's state and
  // handed to something inside DatabaseProvider. This is the shape that must
  // never come back, and it is why the gates read a context instead.
  it('keeps a prop created above the provider at its first-render value', async () => {
    const seenByProbe: boolean[] = [];
    function PropProbe({ ready }: { ready: boolean }) {
      seenByProbe.push(ready);
      return null;
    }

    render(
      <RootLayoutStandIn>
        {(ready) => (
          <DatabaseProvider>
            <PropProbe ready={ready} />
          </DatabaseProvider>
        )}
      </RootLayoutStandIn>,
    );
    await waitFor(() => expect(seenByProbe).toContain(false));

    await flipReady();

    expect(sqliteCtrl.opened).toBe(1);
    expect(seenByProbe.at(-1)).toBe(false);
    expect(seenByProbe).not.toContain(true);
  });
});

describe('the launch gates, mounted inside DatabaseProvider as in app/_layout.tsx', () => {
  function renderRootTree() {
    return render(
      <RootLayoutStandIn>
        {(ready) => (
          <LaunchReadyProvider ready={ready}>
            <DatabaseProvider>
              <ConnectivityBanner />
              <OnboardingGate />
              <QaTesterGate />
              <SendRecoveryGate />
            </DatabaseProvider>
          </LaunchReadyProvider>
        )}
      </RootLayoutStandIn>,
    );
  }

  it('hold still until the root says the app is ready', async () => {
    renderRootTree();
    // The database has opened and the gates have mounted...
    await waitFor(() => expect(decideQaGateMock).toHaveBeenCalled());
    await waitFor(() => expect(decideSendRecoveryMock).toHaveBeenCalled());

    // ...and every one of them is still waiting.
    expect(connectivityBannerHookMock).not.toHaveBeenCalled();
    expect(trackGateMock).not.toHaveBeenCalled();
    expect(decideQaGateMock.mock.calls.every(([input]) => input.ready === false)).toBe(true);
    expect(decideSendRecoveryMock.mock.calls.every(([input]) => input.ready === false)).toBe(true);
  });

  it('all wake up when readiness flips above the provider', async () => {
    renderRootTree();
    await waitFor(() => expect(decideQaGateMock).toHaveBeenCalled());

    await flipReady();

    // ConnectivityBanner mounted its content.
    await waitFor(() => expect(connectivityBannerHookMock).toHaveBeenCalled());
    // OnboardingGate reached a decision (no board bound, so would_present).
    await waitFor(() =>
      expect(trackGateMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'would_present' })),
    );
    // QaTesterGate and SendRecoveryGate decided with the app ready.
    await waitFor(() => expect(decideQaGateMock).toHaveBeenCalledWith(expect.objectContaining({ ready: true })));
    await waitFor(() => expect(decideSendRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({ ready: true })));
    // Without reopening the database: nothing under the provider remounted.
    expect(sqliteCtrl.opened).toBe(1);
  });

  // `connectivity-banner-kill` has to land before the banner's first paint, or a
  // killed fleet still sees it for up to 2 s of every launch.
  it('keeps the banner down until the feature flags have resolved', async () => {
    flagsCtrl.resolved = false;
    renderRootTree();
    await waitFor(() => expect(decideQaGateMock).toHaveBeenCalled());
    await flipReady();
    // The app is ready, but PostHog has not answered yet.
    expect(connectivityBannerHookMock).not.toHaveBeenCalled();

    await act(async () => {
      flagsCtrl.setResolved(true);
    });
    await waitFor(() => expect(connectivityBannerHookMock).toHaveBeenCalled());
  });
});
