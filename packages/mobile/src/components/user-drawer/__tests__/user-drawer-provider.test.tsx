// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const browser = vi.hoisted(() => ({ openBrowserAsync: vi.fn().mockResolvedValue(undefined) }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const signOutMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
// Mutable so a test can set the focused tab before openUserDrawer captures the
// board returnTo (the capture happens at open time, while the tab is still focused).
const segmentsMock = vi.hoisted(() => ({ current: [] as string[] }));
// withTiming completion callbacks are captured (not fired inline) so a test can
// flush the drawer's close animation on demand and assert router.back() fires
// only once it settles.
const reanimated = vi.hoisted(() => ({ closeCallbacks: [] as Array<(finished: boolean) => void> }));
const feedbackPresent = vi.hoisted(() => vi.fn());
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
    t: (key: string) =>
      ({
        'ariaLabels.close': 'Close',
        'ariaLabels.settings': 'Settings',
        'header.you': 'You',
        'myBoards.title': 'My boards',
        'userDrawer.about': 'About',
        'userDrawer.changeBoard': 'Change board',
        'userDrawer.joinDiscord': 'Join Discord',
        'userDrawer.logout': 'Log out',
        'userDrawer.myPlaylists': 'My playlists',
        'userDrawer.newBadge': 'New',
        'userDrawer.rateBoardsesh': 'Rate Boardsesh',
        'userDrawer.reportBug': 'Report a bug',
        'userDrawer.whatsNew': "What's New",
        'mobile.more.signOut.failureTitle': 'Sign-out was not confirmed',
        'mobile.more.signOut.failure': 'Reconnect and sign out again',
      })[key] ?? key,
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
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'user-1', displayName: 'Alex', email: 'alex@example.com', avatarUrl: null } }),
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, signOut: signOutMock }),
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
  signOutFailureAlertMock.mockClear();
  feedbackPresent.mockClear();
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
    ['My boards', '/boards/manage'],
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
    // to ['user-drawer']), so a later Change board returns to discover.
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

  it('Log out closes the drawer, then signs out', () => {
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Log out'));

    expect(signOutMock).not.toHaveBeenCalled();
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);
    expect(signOutMock).toHaveBeenCalledWith('manual');
  });

  it('surfaces a durable manual sign-out failure after local cleanup', async () => {
    const signOutError = new Error('cookie revocation failed');
    signOutMock.mockRejectedValueOnce(signOutError);
    const { rerender } = render(<Harness showScreen />);

    fireEvent.click(screen.getByText('Log out'));
    flushDrawerClose();
    rerender(<Harness showScreen={false} />);

    await waitFor(() =>
      expect(signOutFailureAlertMock).toHaveBeenCalledWith(
        'Sign-out was not confirmed',
        'Reconnect and sign out again',
      ),
    );
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
