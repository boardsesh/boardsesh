// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { TabRouter, type TabNavigationState } from 'expo-router/build/react-navigation/routers/TabRouter';
import { StackRouter, type StackNavigationState } from 'expo-router/build/react-navigation/routers/StackRouter';
import type { RouteNode } from 'expo-router/build/Route';
import { createInitialState } from 'expo-router/build/react-navigation/core/createInitialState';
import { isActionHandled } from 'expo-router/build/react-navigation/routers/utils';
import type { NavigationState, ParamListBase } from 'expo-router/build/react-navigation/routers/types';
import { ROOT_CHAIN, getChainFromRouteKey } from 'expo-router/build/react-navigation/routers/stateKeys';
import { resolveNavigationDestination } from 'expo-router/build/global-state/resolveNavigationDestination';
import { indexNavigationTree, reduceNavigationTree } from 'expo-router/build/global-state/reduceNavigationTree';
import type { RouterRegistry } from 'expo-router/build/global-state/routerRegistry';

const platform = vi.hoisted(() => ({ OS: 'android' }));
const browser = vi.hoisted(() => ({ openBrowserAsync: vi.fn().mockResolvedValue(undefined) }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), dismissTo: vi.fn(), navigate: vi.fn() }));
const signOutMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const confirmSignOutMock = vi.hoisted(() => vi.fn(async (_signal?: AbortSignal) => {}));
type RouteTransitionEvent = { data: { closing: boolean } };
const navigationMocks = vi.hoisted(() => {
  const focus = { current: true };
  const indexListeners = new Map<string, Set<(event: RouteTransitionEvent) => void>>();
  const accountListeners = new Map<string, Set<(event: RouteTransitionEvent) => void>>();
  const subscribe = (
    listeners: Map<string, Set<(event: RouteTransitionEvent) => void>>,
    eventName: string,
    listener: (event: RouteTransitionEvent) => void,
  ) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
    return () => eventListeners.delete(listener);
  };
  const account = {
    addListener: (eventName: string, listener: (event: RouteTransitionEvent) => void) =>
      subscribe(accountListeners, eventName, listener),
  };
  return {
    indexListeners,
    accountListeners,
    focus,
    index: {
      addListener: (eventName: string, listener: (event: RouteTransitionEvent) => void) =>
        subscribe(indexListeners, eventName, listener),
      getParent: () => account,
      isFocused: () => focus.current,
    },
  };
});
// Mutable so a test can set the focused tab before openUserDrawer captures the
// board returnTo (the capture happens at open time, while the tab is still focused).
const segmentsMock = vi.hoisted(() => ({ current: [] as string[] }));
// withTiming completion callbacks are captured (not fired inline) so a test can
// flush the drawer's close animation on demand and assert router.back() fires
// only once it settles.
const reanimated = vi.hoisted(() => ({ closeCallbacks: [] as Array<(finished: boolean) => void> }));
const feedbackPresent = vi.hoisted(() => vi.fn());
const qaVerdictPresent = vi.hoisted(() => vi.fn());
// Crowdsourced-QA rows: mutable so a test can put the drawer on a surfing-capable
// build (and on a preview branch) without touching expo-updates.
const qaState = vi.hoisted(() => ({
  surfingBuild: false,
  runningPrNumber: null as number | null,
  verdictSubmittedKey: null as string | null,
}));
const profileState = vi.hoisted(() => ({ isTester: false }));
// The moderation kill switch and the sign-in state, mutable per test.
const drawerState = vi.hoisted(() => ({ climbModerationEnabled: true, isAuthenticated: true }));
const signOutFailureAlertMock = vi.hoisted(() => vi.fn());

// The launch hold is covered by its own suite; here the screen renders as is.
vi.mock('../../launch-update/hold-until-launch-ready', () => ({
  holdUntilLaunchReady: <Screen,>(Screen: Screen) => Screen,
}));
vi.mock('react-native', () => ({
  Platform: platform,
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) => createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress, type: 'button' }, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    absoluteFill: {},
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
  useWindowDimensions: () => ({ width: 390 }),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  },
  Easing: { cubic: 'cubic', out: () => 'ease' },
  runOnJS: (callback: () => void) => callback,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initialValue: number) => ({ value: initialValue }),
  withTiming: (value: number, _config: unknown, callback?: (finished: boolean) => void) => {
    if (callback) reanimated.closeCallbacks.push(callback);
    return value;
  },
}));

vi.mock('../../HeaderActionButtons', () => ({
  HeaderLeadingButton: ({ onPress }: { onPress: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, 'Close Account'),
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => ReactNode } }) => options?.headerRight?.() ?? null },
  router: routerMock,
  useSegments: () => segmentsMock.current,
  useNavigation: () => navigationMocks.index,
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('expo-web-browser', () => browser);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolates `{{name}}` like the real `t`, so the QA rows (which carry the
    // PR number) assert on the string a user actually reads.
    t: (key: string, values?: Record<string, unknown>) => {
      const template =
        {
          'ariaLabels.close': 'Close',
          'ariaLabels.settings': 'Settings',
          'header.you': 'You',
          'userDrawer.changeBoard': 'Change board',
          'userDrawer.about': 'About',
          'userDrawer.joinDiscord': 'Join Discord',
          'userDrawer.logout': 'Log out',
          'userDrawer.myPlaylists': 'My playlists',
          'userDrawer.newBadge': 'New',
          'userDrawer.rateBoardsesh': 'Rate Boardsesh',
          'userDrawer.reportBug': 'Report a bug',
          'userDrawer.whatsNew': "What's New",
          'userDrawer.qa.pick': 'Test a PR preview',
          'userDrawer.qa.finishTesting': 'Finish testing #{{prNumber}}',
          'userDrawer.qa.testPlan': 'Test plan #{{prNumber}}',
          'userDrawer.qa.badge': 'QA',
          'boards:mobile.myGyms.moreRowTitle': 'My gyms',
          'climbs:mobile.moderation.title': 'Moderation',
          // The labels of the two rows Settings dropped instead of moving here,
          // under both spellings a re-added row would use: a namespaced key on the
          // drawer's `t`, or the bare key on a `useTranslation(namespace)` one.
          'notifications:title': 'Notifications',
          title: 'Notifications',
          'playlists:library.allPlaylists.title': 'All playlists',
          'library.allPlaylists.title': 'All playlists',
          'mobile.settings.signOut.failureTitle': 'Sign-out was not confirmed',
          'mobile.settings.signOut.failure': 'Reconnect and sign out again',
        }[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''));
    },
  }),
}));

vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/sign-out-failure-alert', () => ({ showSignOutFailure: signOutFailureAlertMock }));
// Mock the changelog data + seen-state so importing the screen never reaches the
// real secure-store adapter. hasUnseenChangelog is a vi.fn so a test can flip it
// to exercise the visible "New" pill path (default: nothing unseen → no pill).
const changelogSeen = vi.hoisted(() => ({
  getLastSeenChangelogDate: vi.fn(),
  hasUnseenChangelog: vi.fn(() => false),
}));
vi.mock('../../../lib/changelog', () => ({ latestEntryDate: '2026-01-01T00:00:00.000Z' }));
vi.mock('../../../lib/changelog-seen', () => changelogSeen);
// Reads MMKV-backed settings; the pill's spotlight half has its own suite.
vi.mock('../../../lib/offline-nudges/spotlight-unseen', () => ({
  hasUnseenOfflineSpotlight: async () => false,
}));
// Pulls PostHog into the graph; the pill only asks it whether the spotlight
// could render at all.
vi.mock('../../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => true,
  useClimbModerationEnabled: () => drawerState.climbModerationEnabled,
}));
// AsyncStorage-backed; the spotlight names a board, so the pill asks whether
// there is one.
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { uuid: 'board-1' } }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({
    data: {
      id: 'user-1',
      displayName: 'Alex',
      email: 'alex@example.com',
      avatarUrl: null,
      isTester: profileState.isTester,
    },
  }),
}));
// The QA rows read the surfing capability the root layout published and the
// branch this bundle is running.
vi.mock('../../../lib/ota-branch-surfing-state', () => ({
  useOtaBranchSurfingState: () => ({ surfingBuild: qaState.surfingBuild, ready: true }),
}));
vi.mock('../../../lib/qa/qa-surf', () => ({
  readRunningPrNumber: () => qaState.runningPrNumber,
}));
// `runningQaPrNumberToOffer` itself is NOT mocked — the join between the running
// branch and the persisted verdict marker is the thing under test here. Only its
// two device reads are.
vi.mock('expo-updates', () => ({ updateId: 'bundle-a' }));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => (key === 'qaVerdictSubmittedKey' ? qaState.verdictSubmittedKey : null),
}));
// `useQaMenu` subscribes to the verdict marker rather than reading it once, so
// the drawer's copy of it comes through the hook, not `getSetting`.
vi.mock('../../../settings/hooks', () => ({
  useSetting: (key: string) => [key === 'qaVerdictSubmittedKey' ? qaState.verdictSubmittedKey : null, vi.fn()],
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: drawerState.isAuthenticated, signOut: signOutMock }),
}));
// Raising the dialog and running the wipe is the hook's job, covered by its own
// test. These tests pin whether Log out keeps iOS Account mounted or closes the
// drawer first; the hook tests cover cancellation, errors and double-tap protection.
vi.mock('../../../hooks/use-confirm-sign-out', () => ({
  useConfirmSignOut: () => confirmSignOutMock,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    brandColors: { error: '#c00', primary: '#6D28D9' },
    systemColors: {
      elevatedSurface: '#fff',
      label: '#111',
      secondaryBackground: '#f7f7f7',
      secondaryLabel: '#666',
      separator: '#ddd',
      tertiaryLabel: '#999',
    },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  borderRadius: { lg: 12 },
  overlays: { scrim: 'rgba(0,0,0,0.4)' },
  shadows: { lg: {} },
  spacing: { 2: 8, 3: 12, 4: 16 },
}));

vi.mock('../../Avatar', () => ({
  Avatar: ({ name }: { name: string }) => createElement('span', { 'data-avatar': name }),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../ListRow', () => ({
  ListRow: ({
    leading,
    onPress,
    title,
    trailing,
  }: {
    leading?: ReactNode;
    onPress?: () => void;
    title: string;
    trailing?: ReactNode;
  }) =>
    createElement('button', { 'data-row-title': title, onClick: onPress, type: 'button' }, leading, title, trailing),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../FeedbackSheet', () => ({
  FeedbackSheet: ({ visible }: { visible: boolean }) => {
    useEffect(() => {
      if (visible) feedbackPresent();
    }, [visible]);
    return null;
  },
}));
// Same root-mounted-sheet shape as FeedbackSheet: the real one pulls @expo/ui's
// native bottom sheet into the graph, which can't mount under this suite's
// narrow react-native mock.
vi.mock('../QaVerdictSheet', () => ({
  QaVerdictSheet: ({ sheetRef }: { sheetRef?: { current: { present: () => void } | null } }) => {
    if (sheetRef) sheetRef.current = { present: qaVerdictPresent };
    return null;
  },
}));

import { DISCORD_INVITE_URL } from '../../../lib/discord';
import { UserDrawerProvider, useUserDrawer } from '../UserDrawerProvider';
import UserDrawerScreen, { UserDrawerScreen as AccountMenu } from '../../../../app/user-drawer';

function DrawerTrigger() {
  const { openUserDrawer } = useUserDrawer();
  return (
    <button onClick={openUserDrawer} type="button">
      Open drawer
    </button>
  );
}

// The provider stays mounted (so the root-mounted FeedbackSheet persists);
// toggling `showScreen` mounts/unmounts the route screen the way router.push /
// router.back would. Unmounting the screen is what fires its deferred action.
function Harness({ showScreen }: { showScreen: boolean }) {
  return (
    <UserDrawerProvider>
      <DrawerTrigger />
      {showScreen ? <UserDrawerScreen /> : null}
    </UserDrawerProvider>
  );
}

beforeEach(() => {
  navigationMocks.focus.current = true;
  navigationMocks.indexListeners.clear();
  navigationMocks.accountListeners.clear();
  platform.OS = 'android';
  browser.openBrowserAsync.mockClear();
  routerMock.push.mockReset();
  routerMock.dismissTo.mockReset();
  routerMock.navigate.mockReset();
  routerMock.back.mockReset();
  signOutMock.mockClear();
  signOutMock.mockResolvedValue(undefined);
  confirmSignOutMock.mockClear();
  confirmSignOutMock.mockResolvedValue(undefined);
  signOutFailureAlertMock.mockClear();
  feedbackPresent.mockClear();
  qaVerdictPresent.mockClear();
  qaState.surfingBuild = false;
  qaState.runningPrNumber = null;
  qaState.verdictSubmittedKey = null;
  profileState.isTester = false;
  drawerState.climbModerationEnabled = true;
  drawerState.isAuthenticated = true;
  reanimated.closeCallbacks.length = 0;
  segmentsMock.current = [];
  changelogSeen.getLastSeenChangelogDate.mockResolvedValue('2026-01-01T00:00:00.000Z');
  changelogSeen.hasUnseenChangelog.mockReturnValue(false);
  // The route defers its post-close action one frame past React unmount. Run rAF
  // synchronously so the deferral resolves within the unmounting rerender.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Fire the captured close-animation completion callback(s), which mirror the
// real slide-out finishing and pop the route via router.back().
function flushDrawerClose() {
  act(() => {
    const callbacks = reanimated.closeCallbacks.splice(0);
    callbacks.forEach((callback) => callback(true));
  });
}

// Exercise Expo's installed destination resolver, tree reducer, and routers.
// Complete states carry deterministic keys and routeKeySeq, as SDK 58 requires.
function playlistNavigationState(initialTab: 'profile' | 'discover') {
  const discoverRouter = StackRouter({ initialRouteName: 'index' });
  const discoverConfig = { routeNames: ['index', 'all'], routeGetIdList: {} };
  const tabRouter = TabRouter({ initialRouteName: initialTab });
  const tabConfig = { routeNames: ['discover', 'profile'], routeGetIdList: {} };
  const rootRouter = StackRouter({ initialRouteName: '(tabs)' });
  const rootConfig = { routeNames: ['(tabs)', 'account', 'user-drawer'], routeGetIdList: {} };

  let rootState: NavigationState = {
    ...createInitialState({ ...rootConfig, initialRouteName: '(tabs)', parentChain: ROOT_CHAIN }),
    type: 'stack',
  };
  let tabState: TabNavigationState<ParamListBase> = {
    ...createInitialState({
      ...tabConfig,
      initialRouteName: 'discover',
      parentChain: getChainFromRouteKey(rootState.routes[0].key),
    }),
    type: 'tab',
  };
  const discoverState: StackNavigationState<ParamListBase> = {
    ...createInitialState({
      ...discoverConfig,
      initialRouteName: 'index',
      parentChain: getChainFromRouteKey(tabState.routes[0].key),
    }),
    type: 'stack',
  };
  tabState = { ...tabState, routes: [{ ...tabState.routes[0], state: discoverState }] };
  if (initialTab === 'profile') {
    const result = tabRouter.getStateForAction(tabState, { type: 'NAVIGATE', payload: { name: 'profile' } }, tabConfig);
    expect(isActionHandled(result)).toBe(true);
    if (isActionHandled(result)) tabState = result.state;
  }
  rootState = { ...rootState, routes: [{ ...rootState.routes[0], state: tabState }] };

  const node = (route: string, children: RouteNode[] = []): RouteNode => ({
    type: children.length > 0 ? 'layout' : 'route',
    route,
    contextKey: `${route || 'root'}/${children.length > 0 ? '_layout' : 'index'}.tsx`,
    dynamic: null,
    children,
    loadRoute: () => ({}),
  });
  const discoverNode = node('discover', [node('index'), node('all')]);
  const tabsNode = node('(tabs)', [discoverNode, node('profile')]);
  const rootNode = node('', [tabsNode, node('account'), node('user-drawer')]);
  const registry: RouterRegistry = new Map([
    [
      rootState.key,
      {
        routeNode: rootNode,
        reduce: (state, action) =>
          rootRouter.getStateForAction(
            state as StackNavigationState<ParamListBase>,
            action as Parameters<typeof rootRouter.getStateForAction>[1],
            rootConfig,
          ),
        shouldActionChangeFocus: rootRouter.shouldActionChangeFocus,
        getStateForRouteFocus: (state, key) =>
          rootRouter.getStateForRouteFocus(state as StackNavigationState<ParamListBase>, key),
      },
    ],
    [
      tabState.key,
      {
        routeNode: tabsNode,
        reduce: (state, action) =>
          tabRouter.getStateForAction(
            state as TabNavigationState<ParamListBase>,
            action as Parameters<typeof tabRouter.getStateForAction>[1],
            tabConfig,
          ),
        shouldActionChangeFocus: tabRouter.shouldActionChangeFocus,
        getStateForRouteFocus: (state, key) =>
          tabRouter.getStateForRouteFocus(state as TabNavigationState<ParamListBase>, key),
      },
    ],
    [
      discoverState.key,
      {
        routeNode: discoverNode,
        reduce: (state, action) =>
          discoverRouter.getStateForAction(
            state as StackNavigationState<ParamListBase>,
            action as Parameters<typeof discoverRouter.getStateForAction>[1],
            discoverConfig,
          ),
        shouldActionChangeFocus: discoverRouter.shouldActionChangeFocus,
        getStateForRouteFocus: (state, key) =>
          discoverRouter.getStateForRouteFocus(state as StackNavigationState<ParamListBase>, key),
      },
    ],
  ]);
  routerMock.push.mockImplementation((name: string) => {
    const result = rootRouter.getStateForAction(
      rootState as StackNavigationState<ParamListBase>,
      { type: 'PUSH', payload: { name: name.slice(1) } },
      rootConfig,
    );
    expect(isActionHandled(result)).toBe(true);
    if (isActionHandled(result)) rootState = result.state;
  });
  routerMock.back.mockImplementation(() => {
    const result = rootRouter.getStateForAction(
      rootState as StackNavigationState<ParamListBase>,
      { type: 'POP', payload: { count: 1 } },
      rootConfig,
    );
    if (isActionHandled(result)) rootState = result.state;
  });
  const dispatch = (type: 'NAVIGATE' | 'POP_TO', href: string) => {
    expect(href).toBe('/(tabs)/discover/all');
    const action = resolveNavigationDestination({
      targetState: {
        routes: [{ name: '(tabs)', state: { routes: [{ name: 'discover', state: { routes: [{ name: 'all' }] } }] } }],
      },
      navigationState: rootState,
      routeNode: rootNode,
      registry,
      action: { type, payload: {} },
    });
    const tree = indexNavigationTree(rootState);
    const origin = tree.nodes.get(action.target ?? rootState.key);
    expect(origin).toBeDefined();
    if (!origin) return;
    const result = reduceNavigationTree(action, registry, { tree, origin });
    if (result.handled) rootState = result.nextState;
  };
  const currentTabs = () => rootState.routes.find((route) => route.name === '(tabs)')!.state as NavigationState;
  const currentDiscover = () =>
    currentTabs().routes.find((route) => route.name === 'discover')!.state as NavigationState;
  routerMock.navigate.mockImplementation((href: string) => dispatch('NAVIGATE', href));
  routerMock.dismissTo.mockImplementation((href: string) => dispatch('POP_TO', href));
  return {
    root: () => rootState,
    tab: () => currentTabs().routes[currentTabs().index].name,
    screen: () => currentDiscover().routes[currentDiscover().index].name,
  };
}

describe('My playlists switches to the existing Discover tab', () => {
  it('keeps Profile selected when the stack-only dismissTo action reaches the tab router', () => {
    const navigation = playlistNavigationState('profile');
    routerMock.dismissTo('/(tabs)/discover/all');
    expect(navigation.tab()).toBe('profile');
    expect(navigation.screen()).toBe('index');
  });

  it.each(['ios', 'android', 'web'])(
    'opens playlists after the %s menu unmounts, including repeated visits',
    (platformName) => {
      platform.OS = platformName;
      const navigation = playlistNavigationState('profile');
      const tabsKey = navigation.root().routes[0].key;
      const MenuHarness = ({ showScreen }: { showScreen: boolean }) => (
        <UserDrawerProvider>
          <DrawerTrigger />
          {showScreen ? <AccountMenu presentation={platformName === 'ios' ? 'account' : 'drawer'} /> : null}
        </UserDrawerProvider>
      );
      const { rerender } = render(<MenuHarness showScreen={false} />);

      for (let visit = 0; visit < 2; visit += 1) {
        fireEvent.click(screen.getByText('Open drawer'));
        expect(navigation.root().routes).toHaveLength(2);
        rerender(<MenuHarness showScreen />);
        fireEvent.click(screen.getByText('My playlists'));
        expect(routerMock.navigate).toHaveBeenCalledTimes(visit);
        if (platformName !== 'ios') {
          expect(navigation.root().routes).toHaveLength(2);
          flushDrawerClose();
        }
        expect(navigation.root().routes).toHaveLength(1);
        expect(routerMock.navigate).toHaveBeenCalledTimes(visit);
        rerender(<MenuHarness showScreen={false} />);

        expect(navigation.tab()).toBe('discover');
        expect(navigation.screen()).toBe('all');
        expect(navigation.root().routes.map((route) => route.key)).toEqual([tabsKey]);
      }
    },
  );

  it('opens playlists when Discover is already selected', () => {
    const navigation = playlistNavigationState('discover');
    const { rerender } = render(<Harness showScreen />);
    fireEvent.click(screen.getByText('My playlists'));
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(navigation.tab()).toBe('discover');
    expect(navigation.screen()).toBe('all');
    expect(navigation.root().routes).toHaveLength(1);
  });
});

describe('UserDrawerProvider opens the drawer route', () => {
  it('openUserDrawer pushes the user-drawer route', () => {
    render(<Harness showScreen={false} />);

    fireEvent.click(screen.getByText('Open drawer'));

    expect(routerMock.push).toHaveBeenCalledWith('/user-drawer');
  });
});

describe('user-drawer route Discord CTA', () => {
  it('renders Join Discord directly below Report a bug and opens the invite after the route unmounts', () => {
    const { container, rerender } = render(<Harness showScreen />);

    const rowTitles = Array.from(container.querySelectorAll('[data-row-title]')).map((row) =>
      row.getAttribute('data-row-title'),
    );
    const reportBugIndex = rowTitles.indexOf('Report a bug');

    expect(reportBugIndex).toBeGreaterThan(-1);
    expect(rowTitles[reportBugIndex + 1]).toBe('Join Discord');

    fireEvent.click(screen.getByText('Join Discord'));

    // Deferred: nothing opens while the drawer route is still mounted.
    expect(browser.openBrowserAsync).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(routerMock.back).toHaveBeenCalled();
    expect(browser.openBrowserAsync).not.toHaveBeenCalled();

    // The route's view controller is gone — now the invite opens.
    rerender(<Harness showScreen={false} />);
    expect(browser.openBrowserAsync).toHaveBeenCalledWith(DISCORD_INVITE_URL);
  });
});

// Every row animates the drawer closed, pops the route on settle, then runs its
// action only once the route has unmounted — a single native presentation system
// at every moment (no RN <Modal> stacked under a native @expo/ui sheet, the
// dual-presentation freeze, issue #3211).
describe('user-drawer route defers each action until the route unmounts', () => {
  it.each([
    ['Settings', '/settings'],
    ['My playlists', '/(tabs)/discover/all'],
    ['My gyms', '/gyms/mine'],
    ['Moderation', '/moderation'],
    ["What's New", '/changelog'],
    ['About', '/about'],
  ])('%s closes the drawer, then pushes %s', (rowTitle, route) => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText(rowTitle));

    expect(routerMock.push).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(routerMock.back).toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();

    rerender(<Harness showScreen={false} />);
    if (route === '/(tabs)/discover/all') {
      expect(routerMock.navigate).toHaveBeenCalledWith(route, { withAnchor: true });
    } else {
      expect(routerMock.push).toHaveBeenCalledWith(route);
    }
  });

  it('shows the "New" pill on the What\'s New row when there is an unseen changelog entry', async () => {
    changelogSeen.hasUnseenChangelog.mockReturnValue(true);
    render(<Harness showScreen />);

    // The pill (userDrawer.newBadge) renders only once the mount read of
    // getLastSeenChangelogDate resolves and flips changelogUnseen to true.
    expect(await screen.findByText('New')).toBeTruthy();
  });

  // One Change board row now, not a "Change board" / "My boards" pair (#4623): /boards
  // both switches board and manages them, so this is the only board entry left.
  it('Change board closes the drawer, then pushes the /boards modal route with the returnTo', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Change board'));

    expect(routerMock.push).not.toHaveBeenCalled();
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards', params: { returnTo: '/(tabs)/climbs' } });
  });

  it('captures the focused tab as the board returnTo at open time (from discover)', () => {
    // Focused tab is discover when the drawer is opened — the returnTo must be
    // captured THEN (before /user-drawer is pushed and useSegments would resolve
    // to ['user-drawer']), so a later Change board tap returns to discover.
    segmentsMock.current = ['(tabs)', 'discover'];
    const { rerender } = render(<Harness showScreen={false} />);

    fireEvent.click(screen.getByText('Open drawer'));
    expect(routerMock.push).toHaveBeenCalledWith('/user-drawer');
    routerMock.push.mockClear();

    rerender(<Harness showScreen />);
    fireEvent.click(screen.getByText('Change board'));
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards', params: { returnTo: '/(tabs)/discover' } });
  });

  it('edit profile (header) closes the drawer, then pushes the edit route', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByLabelText('profile.editAction'));

    expect(routerMock.push).not.toHaveBeenCalled();
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(routerMock.push).toHaveBeenCalledWith('/settings/edit');
  });

  it('Rate Boardsesh closes the drawer, then presents the feedback sheet', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Rate Boardsesh'));

    expect(feedbackPresent).not.toHaveBeenCalled();
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(feedbackPresent).toHaveBeenCalled();
  });

  it('Report a bug closes the drawer, then presents the feedback sheet', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Report a bug'));

    expect(feedbackPresent).not.toHaveBeenCalled();
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(feedbackPresent).toHaveBeenCalled();
  });

  // The animated drawer retains its close-first confirmation flow.
  it('Log out closes the drawer, then asks to confirm', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Log out'));

    expect(confirmSignOutMock).not.toHaveBeenCalled();
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(confirmSignOutMock).toHaveBeenCalledTimes(1);
  });

  // The regression that motivated issue #3621: this row used to call signOut
  // directly, so one tap wiped the offline logbook and the downloaded boards with no
  // warning. The confirm now sits between the tap and any sign-out.
  it('never signs out without going through the confirm', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Log out'));
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);

    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('does not pop the route if the slide-out settles after the screen has unmounted (mountedRef guard)', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('About')); // close() captures the slide-out completion callback
    // The screen unmounts first (e.g. the route popped by something else) — then
    // the stale completion callback fires. popRoute must no-op, or it would
    // router.back() the wrong, now-top route.
    rerender(<Harness showScreen={false} />);
    routerMock.back.mockClear();

    flushDrawerClose();
    expect(routerMock.back).not.toHaveBeenCalled();
  });
});

// My gyms and Moderation moved here from Settings, which is now settings only.
describe('user-drawer library rows', () => {
  function rowTitles(container: HTMLElement): (string | null)[] {
    return Array.from(container.querySelectorAll('[data-row-title]')).map((row) => row.getAttribute('data-row-title'));
  }

  it('lists My gyms and Moderation directly under My playlists', () => {
    const { container } = render(<Harness showScreen />);
    const titles = rowTitles(container);
    const playlists = titles.indexOf('My playlists');
    expect(titles.slice(playlists, playlists + 3)).toEqual(['My playlists', 'My gyms', 'Moderation']);
  });

  it('hides My gyms when signed out, and keeps Moderation, which anyone can read', () => {
    drawerState.isAuthenticated = false;
    const { container } = render(<Harness showScreen />);
    const titles = rowTitles(container);
    expect(titles).not.toContain('My gyms');
    expect(titles).toContain('Moderation');
  });

  it('hides Moderation while the moderation kill switch is off', () => {
    drawerState.climbModerationEnabled = false;
    const { container } = render(<Harness showScreen />);
    expect(rowTitles(container)).not.toContain('Moderation');
  });

  it('does not bring back Notifications or All playlists, which the bell and My playlists cover', () => {
    // The labels the old Settings rows used (`notifications:title` and
    // `playlists:library.allPlaylists.title`), resolved through the mock above.
    const { container } = render(<Harness showScreen />);
    const titles = rowTitles(container);
    expect(titles).not.toContain('Notifications');
    expect(titles).not.toContain('All playlists');
  });
});

// Crowdsourced QA (docs/crowdsourced-qa-mobile.md). The rows exist for every
// user on a binary that can actually load a PR preview — the tester role gates
// the cold-start prompt, not the menu entry.
describe('user-drawer crowdsourced-QA rows', () => {
  function rowTitles(container: HTMLElement): (string | null)[] {
    return Array.from(container.querySelectorAll('[data-row-title]')).map((row) => row.getAttribute('data-row-title'));
  }

  it('shows nothing for a tester on a build that cannot surf', () => {
    // The one reason left to hide the row: the app physically cannot load a
    // preview here, so offering it would be a lie.
    profileState.isTester = true;
    qaState.surfingBuild = false;
    const { container } = render(<Harness showScreen />);

    expect(rowTitles(container)).not.toContain('Test a PR preview');
  });

  it('offers the picker to a non-tester on a surfing build', () => {
    // The regression this whole change exists to fix: a non-tester used to get
    // no entry point at all, so "switched off" and "nothing to test" were
    // indistinguishable from "the button is gone".
    profileState.isTester = false;
    qaState.surfingBuild = true;
    const { container } = render(<Harness showScreen />);

    expect(rowTitles(container)).toContain('Test a PR preview');
  });

  it('offers the picker on production and pushes it once the route unmounts', () => {
    profileState.isTester = true;
    qaState.surfingBuild = true;
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Test a PR preview'));

    expect(routerMock.push).not.toHaveBeenCalled();
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(routerMock.push).toHaveBeenCalledWith('/qa/pick');
  });

  it('offers finish + test plan while running a preview', () => {
    profileState.isTester = true;
    qaState.surfingBuild = true;
    qaState.runningPrNumber = 4792;
    const { container } = render(<Harness showScreen />);

    const titles = rowTitles(container);
    expect(titles).toContain('Finish testing #4792');
    expect(titles).toContain('Test plan #4792');
    expect(titles).not.toContain('Test a PR preview');
  });

  // Same rule as Rate / Report a bug: the verdict sheet is mounted at the
  // provider root and presents off the ROOT view controller, so it can only be
  // presented once the drawer route's own controller is gone (#3211).
  it('presents the verdict sheet only after the drawer route has unmounted', () => {
    profileState.isTester = true;
    qaState.surfingBuild = true;
    qaState.runningPrNumber = 4792;
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Finish testing #4792'));

    expect(qaVerdictPresent).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(qaVerdictPresent).not.toHaveBeenCalled();

    rerender(<Harness showScreen={false} />);
    expect(qaVerdictPresent).toHaveBeenCalledTimes(1);
  });

  it('stops offering to finish a bundle whose verdict is already filed', () => {
    // Leaving a preview usually answers `nothing-to-load`, so the tester is
    // still running the branch they just signed off. Without the marker the
    // drawer would keep asking them to finish it — over and over.
    profileState.isTester = true;
    qaState.surfingBuild = true;
    qaState.runningPrNumber = 4792;
    qaState.verdictSubmittedKey = 'user-1:pr-4792:bundle-a';
    const { container } = render(<Harness showScreen />);

    const titles = rowTitles(container);
    expect(titles).not.toContain('Finish testing #4792');
    expect(titles).toContain('Test a PR preview');
  });

  it('offers to finish again once the author publishes a new bundle', () => {
    // Same branch, different updateId: a different thing to test.
    profileState.isTester = true;
    qaState.surfingBuild = true;
    qaState.runningPrNumber = 4792;
    qaState.verdictSubmittedKey = 'user-1:pr-4792:bundle-zero';
    const { container } = render(<Harness showScreen />);

    expect(rowTitles(container)).toContain('Finish testing #4792');
  });

  it('keeps offering a bundle a DIFFERENT tester signed off on this device', () => {
    // The settings store is device-wide, the markers are account-scoped: the
    // signed-in user here is user-1, so user-a's sign-off is not theirs.
    profileState.isTester = true;
    qaState.surfingBuild = true;
    qaState.runningPrNumber = 4792;
    qaState.verdictSubmittedKey = 'user-a:pr-4792:bundle-a';
    const { container } = render(<Harness showScreen />);

    expect(rowTitles(container)).toContain('Finish testing #4792');
  });

  it('pushes the brief from the test-plan row once the route unmounts', () => {
    profileState.isTester = true;
    qaState.surfingBuild = true;
    qaState.runningPrNumber = 4792;
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Test plan #4792'));
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);

    expect(routerMock.push).toHaveBeenCalledWith('/qa/brief');
  });
});

describe('native Account navigation', () => {
  it('aborts preparation before the Account close button pops its route', () => {
    platform.OS = 'ios';
    confirmSignOutMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    render(
      <UserDrawerProvider>
        <AccountMenu presentation="account" />
      </UserDrawerProvider>,
    );
    fireEvent.click(screen.getByText('Log out'));
    const signal = confirmSignOutMock.mock.calls[0][0];
    expect(signal?.aborted).toBe(false);
    routerMock.back.mockImplementationOnce(() => expect(signal?.aborted).toBe(true));

    fireEvent.click(screen.getByText('Close Account'));

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });

  it.each(['unmount', 'blur'])('aborts preparation on Account %s', (boundary) => {
    platform.OS = 'ios';
    confirmSignOutMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    const { unmount } = render(
      <UserDrawerProvider>
        <AccountMenu presentation="account" />
      </UserDrawerProvider>,
    );
    fireEvent.click(screen.getByText('Log out'));
    const signal = confirmSignOutMock.mock.calls[0][0];

    if (boundary === 'unmount') unmount();
    else
      act(() =>
        navigationMocks.indexListeners.get('blur')?.forEach((listener) => listener({ data: { closing: true } })),
      );

    expect(signal?.aborted).toBe(true);
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('cancels on the parent modal closing and preserves a fresh retry after gesture cancellation', async () => {
    platform.OS = 'ios';
    let finishOriginal = () => {};
    confirmSignOutMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOriginal = resolve;
        }),
    );
    confirmSignOutMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    render(
      <UserDrawerProvider>
        <AccountMenu presentation="account" />
      </UserDrawerProvider>,
    );
    fireEvent.click(screen.getByText('Log out'));
    const originalSignal = confirmSignOutMock.mock.calls[0][0];
    act(() =>
      navigationMocks.indexListeners
        .get('transitionStart')
        ?.forEach((listener) => listener({ data: { closing: true } })),
    );
    expect(originalSignal?.aborted).toBe(false);

    act(() =>
      navigationMocks.accountListeners
        .get('transitionStart')
        ?.forEach((listener) => listener({ data: { closing: true } })),
    );
    expect(originalSignal?.aborted).toBe(true);
    fireEvent.click(screen.getByText('Log out'));
    expect(confirmSignOutMock).toHaveBeenCalledTimes(1);

    act(() =>
      navigationMocks.accountListeners
        .get('gestureCancel')
        ?.forEach((listener) => listener({ data: { closing: false } })),
    );
    fireEvent.click(screen.getByText('Log out'));
    const retrySignal = confirmSignOutMock.mock.calls[1][0];
    expect(retrySignal).not.toBe(originalSignal);
    expect(retrySignal?.aborted).toBe(false);
    await act(async () => finishOriginal());

    fireEvent.click(screen.getByText('Log out'));
    expect(confirmSignOutMock).toHaveBeenCalledTimes(2);
    expect(retrySignal?.aborted).toBe(false);
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('confirms sign-out while iOS Account remains mounted and allows another attempt', async () => {
    platform.OS = 'ios';
    render(
      <UserDrawerProvider>
        <AccountMenu presentation="account" />
      </UserDrawerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Log out'));
    });

    expect(confirmSignOutMock).toHaveBeenCalledTimes(1);
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(reanimated.closeCallbacks).toHaveLength(0);
    expect(signOutMock).not.toHaveBeenCalled();

    // The hook resolves without navigation on cancel or a handled sign-out
    // failure. The same mounted row must still work after either outcome.
    await act(async () => {
      fireEvent.click(screen.getByText('Log out'));
    });

    expect(confirmSignOutMock).toHaveBeenCalledTimes(2);
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it.each(['android', 'web'])('closes Account before confirming on %s', async (platformName) => {
    platform.OS = platformName;
    const AccountHarness = ({ showScreen }: { showScreen: boolean }) => (
      <UserDrawerProvider>{showScreen ? <AccountMenu presentation="account" /> : null}</UserDrawerProvider>
    );
    const { rerender } = render(<AccountHarness showScreen />);

    fireEvent.click(screen.getByText('Log out'));

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(confirmSignOutMock).not.toHaveBeenCalled();
    await act(async () => {
      rerender(<AccountHarness showScreen={false} />);
    });
    expect(confirmSignOutMock).toHaveBeenCalledTimes(1);
  });

  it.each(['ios', 'android', 'web'])('keeps drawer sign-out close-first on %s', async (platformName) => {
    platform.OS = platformName;
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Log out'));

    expect(routerMock.back).not.toHaveBeenCalled();
    expect(confirmSignOutMock).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(confirmSignOutMock).not.toHaveBeenCalled();
    await act(async () => {
      rerender(<Harness showScreen={false} />);
    });
    expect(confirmSignOutMock).toHaveBeenCalledTimes(1);
  });

  it('opens the native account sheet from the iOS avatar', () => {
    platform.OS = 'ios';
    render(<Harness showScreen={false} />);
    fireEvent.click(screen.getByText('Open drawer'));
    expect(routerMock.push).toHaveBeenCalledWith('/account');
  });
  it('pushes Settings and Edit profile inside Account without dismissing the sheet', () => {
    platform.OS = 'ios';
    render(
      <UserDrawerProvider>
        <AccountMenu presentation="account" />
      </UserDrawerProvider>,
    );
    fireEvent.click(screen.getByText('Settings'));
    expect(routerMock.push).toHaveBeenCalledWith('/account/settings');
    fireEvent.click(screen.getByLabelText('profile.editAction'));
    expect(routerMock.push).toHaveBeenCalledWith('/account/settings/edit');
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(reanimated.closeCallbacks).toHaveLength(0);
  });
});
