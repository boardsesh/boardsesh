// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const browser = vi.hoisted(() => ({ openBrowserAsync: vi.fn().mockResolvedValue(undefined) }));

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
    callback?.(true);
    return value;
  },
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
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
  useProfile: () => ({ data: { displayName: 'Alex', email: 'alex@example.com', avatarUrl: null } }),
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
vi.mock('../FeedbackSheet', () => ({ FeedbackSheet: () => null }));

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
});

describe('UserDrawerProvider Discord CTA', () => {
  it('renders Join Discord directly below Report a bug and opens the invite', () => {
    const { container } = render(
      <UserDrawerProvider>
        <DrawerTrigger />
      </UserDrawerProvider>,
    );

    fireEvent.click(screen.getByText('Open drawer'));

    const rowTitles = Array.from(container.querySelectorAll('[data-row-title]')).map((row) =>
      row.getAttribute('data-row-title'),
    );
    const reportBugIndex = rowTitles.indexOf('Report a bug');

    expect(reportBugIndex).toBeGreaterThan(-1);
    expect(rowTitles[reportBugIndex + 1]).toBe('Join Discord');

    fireEvent.click(screen.getByText('Join Discord'));

    expect(browser.openBrowserAsync).toHaveBeenCalledWith(DISCORD_INVITE_URL);
  });
});
