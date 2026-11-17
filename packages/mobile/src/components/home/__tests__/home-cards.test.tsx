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
  userId: 'user-1' as string | undefined,
  now: new Date(2026, 9, 28, 12).getTime(),
}));
const DAY_MS = 24 * 60 * 60 * 1000;

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
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => router }));
vi.mock('../../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => state.backgrounded }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => state.now }));
vi.mock('../../../lib/preference-store', () => ({
  getPreference: vi.fn(async () => null),
  setPreference: vi.fn(async () => {}),
  removePreference: vi.fn(async () => {}),
}));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: state.userId, isLoading: false }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (difficultyId: number | null | undefined) => `V${difficultyId}`,
  }),
}));
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
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, title),
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

import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { rememberEndedWorkout, resetEndedWorkoutStoreForTests } from '../../../lib/ended-workout-store';
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
  state.userId = 'user-1';
  state.now = new Date(2026, 9, 28, 12).getTime();
  resetEndedWorkoutStoreForTests();
});

const fourByFour: WorkoutRun = {
  stages: [{ id: 'main', kind: 'fourByFour', itemUuids: ['q1', 'q2'], targetGrade: 20 }],
};

function rememberWorkout(userId: string | null, endedDaysAgo: number) {
  rememberEndedWorkout(
    {
      sessionId: `session-${userId}-${endedDaysAgo}`,
      run: fourByFour,
      log: [
        { queueItemUuid: 'q1', status: 'send', climbedAt: '2026-10-28T11:00:00Z', tickUuid: 'tick-1' },
        { queueItemUuid: 'q2', status: 'attempt', climbedAt: '2026-10-28T11:05:00Z', tickUuid: 'tick-2' },
      ],
    },
    state.now - endedDaysAgo * DAY_MS,
    userId,
  );
}

afterEach(() => {
  cleanup();
});

describe('HomeSessionSection', () => {
  it('says what starting offers, with one Start button, when there is no recap', () => {
    render(createElement(HomeSessionSection));
    expect(screen.getByText('mobile.home.sections.session.startBody')).toBeTruthy();
    expect(screen.getByTestId('home-session-start').textContent).toBe('mobile.home.sections.session.startTitle');
    expect(screen.queryByTestId('home-session-last-workout')).toBeNull();
    expect(screen.queryByTestId('home-session-open')).toBeNull();
  });

  it("shows yesterday's workout and its detail line in place of the start line", () => {
    rememberWorkout('user-1', 1);
    render(createElement(HomeSessionSection));
    const lastWorkout = screen.getByTestId('home-session-last-workout');
    expect(lastWorkout.textContent).toContain('mobile.home.sections.session.lastWorkoutYesterday');
    // The 4x4 block at the climber's grade label, then the one send logged (the attempt is not one).
    expect(lastWorkout.textContent).toContain('workout.blockNameAtGrade');
    expect(lastWorkout.textContent).toContain('"grade":"V20"');
    expect(lastWorkout.textContent).toContain('mobile.home.sections.session.lastWorkoutSends {"count":1}');
    expect(screen.queryByText('mobile.home.sections.session.startBody')).toBeNull();
    expect(screen.getByTestId('home-session-start')).toBeTruthy();
  });

  it('says Today for a workout that ended today, and the weekday or date for an older one', () => {
    rememberWorkout('user-1', 0);
    render(createElement(HomeSessionSection));
    expect(screen.getByTestId('home-session-last-workout').textContent).toContain(
      'mobile.home.sections.session.lastWorkoutToday',
    );
    cleanup();
    resetEndedWorkoutStoreForTests();
    rememberWorkout('user-1', 3);
    render(createElement(HomeSessionSection));
    expect(screen.getByTestId('home-session-last-workout').textContent).toContain(
      'mobile.home.sections.session.lastWorkoutOn {"day":"Sunday"}',
    );
    cleanup();
    resetEndedWorkoutStoreForTests();
    rememberWorkout('user-1', 10);
    render(createElement(HomeSessionSection));
    expect(screen.getByTestId('home-session-last-workout').textContent).toContain(
      'mobile.home.sections.session.lastWorkoutOn {"day":"Oct 18"}',
    );
  });

  it("never shows another account's workout", () => {
    rememberWorkout('user-2', 1);
    render(createElement(HomeSessionSection));
    expect(screen.queryByTestId('home-session-last-workout')).toBeNull();
    expect(screen.getByText('mobile.home.sections.session.startBody')).toBeTruthy();
  });

  it('shows no workout while the account is unknown', () => {
    rememberWorkout('user-1', 1);
    state.userId = undefined;
    render(createElement(HomeSessionSection));
    expect(screen.queryByTestId('home-session-last-workout')).toBeNull();
  });

  it('counts Start as a session prompt and a Home tap, and opens the Session tab', () => {
    render(createElement(HomeSessionSection));
    fireEvent.click(screen.getByTestId('home-session-start'));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/record');
    expect(analytics.track.mock.calls).toEqual([
      ['Start Session Prompt Tapped', { surface: 'home_session_card', variant: 'home_session_card' }],
      ['Home Section Tapped', { section: 'session', target: 'start' }],
    ]);
  });

  it('shows a running session without its timer until the start time loads', () => {
    state.sessionId = 'session-1';
    render(createElement(HomeSessionSection));
    expect(screen.getByText('mobile.home.sections.session.running')).toBeTruthy();
    expect(screen.queryByTestId('session-timer')).toBeNull();
    fireEvent.click(screen.getByTestId('home-session-open'));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/record');
    // Opening a running session is a Home tap, not a Start.
    expect(analytics.track).toHaveBeenCalledExactlyOnceWith('Home Section Tapped', {
      section: 'session',
      target: 'open',
    });
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
  it('lists At your level, Hidden gems and Fresh without counts while they are unknown', () => {
    render(createElement(HomePlaylistsSection));
    expect(screen.getByTestId('home-playlists-at-your-level').getAttribute('aria-label')).toBe(
      'library.smart.atYourLevel.title',
    );
    expect(screen.getByTestId('home-playlists-hidden-gems').getAttribute('aria-label')).toBe(
      'library.smart.hiddenGems.title',
    );
    expect(screen.getByTestId('home-playlists-fresh').getAttribute('aria-label')).toBe('library.smart.fresh.title');
    expect(screen.queryByTestId('home-playlists-liked-climbs')).toBeNull();
    expect(screen.queryByTestId('home-playlists-projects')).toBeNull();
    expect(screen.getByText('mobile.home.sections.playlists.title')).toBeTruthy();
    expect(state.countsInput.at(-1)).toEqual({ token: 'token-1', tokenLoading: false, isAuthenticated: true });
  });

  it('adds the counts once they load', () => {
    state.smartCounts = [
      { type: 'RECOMMENDED_AT_LEVEL', count: 12 },
      { type: 'RECOMMENDED_HIDDEN_GEMS', count: 0 },
    ];
    render(createElement(HomePlaylistsSection));
    expect(screen.getByTestId('home-playlists-at-your-level').getAttribute('aria-label')).toBe(
      'library.smart.atYourLevel.title, detail.climbCount {"count":12}',
    );
    expect(screen.getByTestId('home-playlists-hidden-gems').getAttribute('aria-label')).toBe(
      'library.smart.hiddenGems.title, detail.climbCount {"count":0}',
    );
  });

  it('opens a list tagged as opened from Home, and All playlists on Discover, counting each tap', () => {
    render(createElement(HomePlaylistsSection));
    fireEvent.click(screen.getByTestId('home-playlists-at-your-level'));
    // With its anchor, so Back lands on Discover's main page, opened or not.
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      { pathname: '/(tabs)/discover/smart/[type]', params: { type: 'RECOMMENDED_AT_LEVEL', source: 'home' } },
      { withAnchor: true },
    );
    fireEvent.click(screen.getByTestId('home-playlists-all'));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/discover');
    expect(analytics.track.mock.calls).toEqual([
      ['Home Section Tapped', { section: 'playlists', target: 'RECOMMENDED_AT_LEVEL' }],
      ['Home Section Tapped', { section: 'playlists', target: 'all' }],
    ]);
  });
});
