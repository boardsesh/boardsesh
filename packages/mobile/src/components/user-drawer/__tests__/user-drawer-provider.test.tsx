// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const browser = vi.hoisted(() => ({ openBrowserAsync: vi.fn().mockResolvedValue(undefined) }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const signOutMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const confirmSignOutMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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
const signOutFailureAlertMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
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
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles, hairlineWidth: 1 },
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

vi.mock('expo-router', () => ({
  router: routerMock,
  useSegments: () => segmentsMock.current,
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
          'mobile.more.signOut.failureTitle': 'Sign-out was not confirmed',
          'mobile.more.signOut.failure': 'Reconnect and sign out again',
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
  useAuth: () => ({ isAuthenticated: true, signOut: signOutMock }),
}));
// Raising the dialog and running the wipe is the hook's job, covered by its own
// test. What matters here is that Log out routes through it at all — the drawer used
// to sign out directly, with no confirmation — and only once the drawer has closed.
vi.mock('../../../hooks/use-confirm-sign-out', () => ({
  useConfirmSignOut: () => confirmSignOutMock,
}));
vi.mock('../../../providers/theme-provider', () => ({
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
  FeedbackSheet: ({ sheetRef }: { sheetRef?: { current: { present: () => void } | null } }) => {
    if (sheetRef) sheetRef.current = { present: feedbackPresent };
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
import UserDrawerScreen from '../../../../app/user-drawer';

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
  browser.openBrowserAsync.mockClear();
  routerMock.push.mockClear();
  routerMock.back.mockClear();
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
  reanimated.closeCallbacks.length = 0;
  segmentsMock.current = [];
  changelogSeen.getLastSeenChangelogDate.mockResolvedValue('2026-01-01T00:00:00.000Z');
  changelogSeen.hasUnseenChangelog.mockReturnValue(false);
  // The route defers its post-close action one frame past unmount (so the route
  // VC dismissal flushes before a sheet presents). Run rAF synchronously so the
  // deferral resolves within the unmounting rerender the tests drive.
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
    ['Settings', '/(tabs)/profile/more'],
    ['My playlists', '/(tabs)/discover/all'],
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
    expect(routerMock.push).toHaveBeenCalledWith(route);
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
    expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/profile/edit');
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

  // The dialog is a native Alert on iOS, so raising it before the drawer has slid
  // away would put it over a half-dismissed drawer.
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
