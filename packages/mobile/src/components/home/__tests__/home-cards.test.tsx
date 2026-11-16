// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const router = vi.hoisted(() => ({ push: vi.fn(), navigate: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const state = vi.hoisted(() => ({
  sessionId: null as string | null,
  startedAt: null as string | null,
  focused: true,
  backgrounded: false,
  smartCounts: undefined as Array<{ type: string; count: number }> | undefined,
  countsInput: [] as Array<{ token: string | null; isAuthenticated: boolean }>,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => state.focused }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => router }));
vi.mock('../../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => state.backgrounded }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useSessionSummary: (sessionId: string | null) => ({
    data: sessionId && state.startedAt ? { startedAt: state.startedAt } : undefined,
  }),
}));
vi.mock('../../../lib/graphql/use-auth-token', () => ({
  useAuthToken: () => ({ data: 'token-1', isLoading: false }),
}));
vi.mock('@boardsesh/playlists-react', () => ({
  useSmartPlaylistCounts: (input: { token: string | null; isAuthenticated: boolean }) => {
    state.countsInput.push(input);
    return { data: state.smartCounts };
  },
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: state.sessionId, undoScope: '' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: {},
    brandColors: { primary: 'brand' },
    selection: { text: 'label', checkmark: 'accent', fill: 'fill' },
  }),
}));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'data-testid': testID }, children),
}));
vi.mock('../../playlist/PlaylistPreviewSquare', () => ({ PlaylistPreviewSquare: () => null }));
vi.mock('../../session-screen/in-session/SessionTimer', () => ({
  SessionTimer: ({ startedAt }: { startedAt: string | null }) =>
    startedAt ? createElement('time', { 'data-testid': 'session-timer' }, startedAt) : null,
}));

import { HomeSessionSection } from '../HomeSessionSection';
import { HomePlaylistsSection } from '../HomePlaylistsSection';

beforeEach(() => {
  router.push.mockClear();
  router.navigate.mockClear();
  analytics.track.mockClear();
  state.sessionId = null;
  state.startedAt = null;
  state.focused = true;
  state.backgrounded = false;
  state.smartCounts = undefined;
  state.countsInput = [];
});

afterEach(() => {
  cleanup();
});

describe('HomeSessionSection', () => {
  it('offers Start a session, which opens the Session tab and counts the tap', () => {
    render(createElement(HomeSessionSection));
    fireEvent.click(screen.getByTestId('home-session-start'));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/record');
    expect(analytics.track).toHaveBeenCalledExactlyOnceWith('Start Session Prompt Tapped', {
      surface: 'home_session_card',
      variant: 'home_session_card',
    });
    expect(screen.queryByTestId('home-session-open')).toBeNull();
  });

  it('shows a running session without its timer until the start time loads', () => {
    state.sessionId = 'session-1';
    render(createElement(HomeSessionSection));
    expect(screen.getByText('mobile.home.sections.session.running')).toBeTruthy();
    expect(screen.queryByTestId('session-timer')).toBeNull();
    fireEvent.click(screen.getByTestId('home-session-open'));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/record');
    // Opening a running session is not a Start.
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('ticks the timer only while Home is on screen', () => {
    state.sessionId = 'session-1';
    state.startedAt = '2026-10-18T10:00:00Z';
    render(createElement(HomeSessionSection));
    expect(screen.getByTestId('session-timer')).toBeTruthy();
    cleanup();
    state.focused = false;
    render(createElement(HomeSessionSection));
    expect(screen.queryByTestId('session-timer')).toBeNull();
    cleanup();
    state.focused = true;
    state.backgrounded = true;
    render(createElement(HomeSessionSection));
    expect(screen.queryByTestId('session-timer')).toBeNull();
  });
});

describe('HomePlaylistsSection', () => {
  it('lists Liked climbs and Projects without counts while they are unknown', () => {
    render(createElement(HomePlaylistsSection));
    expect(screen.getByTestId('home-playlists-liked-climbs').getAttribute('aria-label')).toBe(
      'library.smart.likedClimbs.title',
    );
    expect(screen.getByTestId('home-playlists-projects').getAttribute('aria-label')).toBe(
      'library.smart.projects.title',
    );
    expect(state.countsInput.at(-1)).toEqual({ token: 'token-1', tokenLoading: false, isAuthenticated: true });
  });

  it('adds the counts once they load', () => {
    state.smartCounts = [
      { type: 'LIKED_CLIMBS', count: 12 },
      { type: 'PROJECTS', count: 0 },
    ];
    render(createElement(HomePlaylistsSection));
    expect(screen.getByTestId('home-playlists-liked-climbs').getAttribute('aria-label')).toBe(
      'library.smart.likedClimbs.title, detail.climbCount {"count":12}',
    );
    expect(screen.getByTestId('home-playlists-projects').getAttribute('aria-label')).toBe(
      'library.smart.projects.title, detail.climbCount {"count":0}',
    );
  });

  it('opens a list tagged as opened from Home, and All playlists on Discover', () => {
    render(createElement(HomePlaylistsSection));
    fireEvent.click(screen.getByTestId('home-playlists-liked-climbs'));
    // With its anchor, so Back lands on Discover's main page, opened or not.
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      { pathname: '/(tabs)/discover/smart/[type]', params: { type: 'LIKED_CLIMBS', source: 'home' } },
      { withAnchor: true },
    );
    fireEvent.click(screen.getByTestId('home-playlists-all'));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/discover');
  });
});
