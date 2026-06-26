// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const browser = vi.hoisted(() => ({ openBrowserAsync: vi.fn().mockResolvedValue(undefined) }));
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
// withTiming completion callbacks are captured (not fired inline) so a test can
// assert an action is deferred while the drawer is still up, then flush the close
// animation to prove it runs only after the Modal unmounts.
const reanimated = vi.hoisted(() => ({ closeCallbacks: [] as Array<(finished: boolean) => void> }));
const feedbackPresent = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? createElement('div', { 'data-modal': 'true' }, children) : null,
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
  useSegments: () => [],
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
        'userDrawer.rateBoardsesh': 'Rate Boardsesh',
        'userDrawer.reportBug': 'Report a bug',
      })[key] ?? key,
  }),
}));

vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'user-1', displayName: 'Alex', email: 'alex@example.com', avatarUrl: null } }),
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, signOut: vi.fn().mockResolvedValue(undefined) }),
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
  ListRow: ({ leading, onPress, title }: { leading?: ReactNode; onPress?: () => void; title: string }) =>
    createElement('button', { 'data-row-title': title, onClick: onPress, type: 'button' }, leading, title),
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

function DrawerTrigger() {
  const { openUserDrawer } = useUserDrawer();
  return (
    <button onClick={openUserDrawer} type="button">
      Open drawer
    </button>
  );
}

beforeEach(() => {
  browser.openBrowserAsync.mockClear();
  routerMock.push.mockClear();
  feedbackPresent.mockClear();
  reanimated.closeCallbacks.length = 0;
  // The deferred action runs via requestAnimationFrame one frame after the Modal
  // unmounts — run it inline so the flush below is synchronous.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

// Fire the captured drawer-close completion callback(s), which flip drawerMounted
// to false and let the deferred action run. Mirrors the real close animation
// finishing.
function flushDrawerClose() {
  act(() => {
    const callbacks = reanimated.closeCallbacks.splice(0);
    callbacks.forEach((callback) => callback(true));
  });
}

function openDrawer() {
  fireEvent.click(screen.getByText('Open drawer'));
}

function renderDrawer() {
  return render(
    <UserDrawerProvider>
      <DrawerTrigger />
    </UserDrawerProvider>,
  );
}

describe('UserDrawerProvider Discord CTA', () => {
  it('renders Join Discord directly below Report a bug and opens the invite', () => {
    const { container } = renderDrawer();

    openDrawer();

    const rowTitles = Array.from(container.querySelectorAll('[data-row-title]')).map((row) =>
      row.getAttribute('data-row-title'),
    );
    const reportBugIndex = rowTitles.indexOf('Report a bug');

    expect(reportBugIndex).toBeGreaterThan(-1);
    expect(rowTitles[reportBugIndex + 1]).toBe('Join Discord');

    fireEvent.click(screen.getByText('Join Discord'));

    // Deferred until the drawer Modal has closed.
    expect(browser.openBrowserAsync).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(browser.openBrowserAsync).toHaveBeenCalledWith(DISCORD_INVITE_URL);
  });
});

// Regression: tapping a drawer row must not navigate/present while the drawer's
// RN Modal is still on screen — after a native @expo/ui sheet has been opened,
// that concurrent presentation deadlocks UIKit and freezes the whole app. Every
// row defers its action until the Modal has unmounted.
describe('UserDrawerProvider defers navigation until the drawer closes', () => {
  it.each([
    ['Settings', '/(tabs)/profile/more'],
    ['My playlists', '/(tabs)/discover/all'],
    ['About', '/about'],
    ['My boards', '/boards/manage'],
  ])('%s waits for the drawer to close, then pushes %s', (rowTitle, route) => {
    renderDrawer();
    openDrawer();

    fireEvent.click(screen.getByText(rowTitle));

    expect(routerMock.push).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(routerMock.push).toHaveBeenCalledWith(route);
  });

  it('Change board waits for the drawer to close, then pushes the /boards modal route', () => {
    renderDrawer();
    openDrawer();

    fireEvent.click(screen.getByText('Change board'));

    expect(routerMock.push).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards', params: { returnTo: '/(tabs)/climbs' } });
  });

  it('edit profile (header) waits for the drawer to close, then pushes the edit route', () => {
    renderDrawer();
    openDrawer();

    fireEvent.click(screen.getByLabelText('profile.editAction'));

    expect(routerMock.push).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/profile/edit');
  });

  it('feedback (Rate Boardsesh) waits for the drawer to close, then presents the sheet', () => {
    renderDrawer();
    openDrawer();

    fireEvent.click(screen.getByText('Rate Boardsesh'));

    expect(feedbackPresent).not.toHaveBeenCalled();
    flushDrawerClose();
    expect(feedbackPresent).toHaveBeenCalled();
  });
});
