// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import type { LiveCardModel } from '../../live-sessions/live-session-model';
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
  liveCards: undefined as LiveCardModel[] | undefined,
  liveStatus: 'success' as 'pending' | 'success' | 'error',
  liveBlocked: null as null | 'offline' | 'error',
  liveCalls: [] as Array<{ boardUuid: string | null; enabled: boolean }>,
  fontScale: 1,
}));
const DAY_MS = 24 * 60 * 60 * 1000;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: state.fontScale }),
}));
vi.mock('expo-router', () => ({ useIsFocused: () => state.focused }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The Join label's length decides whether it carries a name, so it reads like the real string.
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'mobile.home.sections.session.joinName'
        ? `Join ${String(options?.name)}`
        : options
          ? `${key} ${JSON.stringify(options)}`
          : key,
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
    formatGrade: (grade: string | null | undefined) => (grade ? `fmt(${grade})` : null),
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useSessionSummary: (sessionId: string | null) => ({
    data: sessionId && state.startedAt ? { startedAt: state.startedAt } : undefined,
  }),
}));
vi.mock('../../../lib/graphql/hooks/use-live-sessions', () => ({
  useFollowedLiveSessions: (boardUuid: string | null, enabled: boolean) => {
    state.liveCalls.push({ boardUuid, enabled });
    return {
      data: enabled ? state.liveCards : undefined,
      status: enabled ? state.liveStatus : 'pending',
      fetchStatus: 'idle',
      refetch: vi.fn(),
    };
  },
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () =>
    state.liveBlocked ? { isBlocked: true, reason: state.liveBlocked } : { isBlocked: false, reason: null },
}));
vi.mock('../../live-sessions/LiveDot', () => ({ LiveDot: () => null, useLivePulseDriver: () => {} }));
vi.mock('../../live-sessions/use-live-session-colors', () => ({
  useLiveSessionColors: () => ({ live: 'live', label: 'label', meta: 'meta' }),
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
  Button: ({
    title,
    onPress,
    testID,
    variant,
  }: {
    title: string;
    onPress: () => void;
    testID?: string;
    variant?: string;
  }) => createElement('button', { onClick: onPress, 'data-testid': testID, 'data-variant': variant }, title),
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
  state.liveCards = [];
  state.liveStatus = 'success';
  state.liveBlocked = null;
  state.liveCalls = [];
  state.fontScale = 1;
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

function renderSession(props: { liveBoardUuid?: string | null; liveEnabled?: boolean } = {}) {
  return render(
    createElement(HomeSessionSection, {
      liveBoardUuid: props.liveBoardUuid ?? null,
      liveEnabled: props.liveEnabled ?? true,
    }),
  );
}

function liveCard(sessionId: string, overrides: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    sessionId,
    startedAtMs: state.now - 42 * 60_000,
    host: { userId: `host-${sessionId}`, displayName: 'Anna Kowalski', avatarUrl: null },
    participants: [{ userId: `host-${sessionId}`, displayName: 'Anna Kowalski', avatarUrl: null }],
    participantCount: 1,
    followedParticipantIds: [`host-${sessionId}`],
    viewerIsMember: false,
    boardName: 'Kilter Original',
    boardType: 'kilter',
    gymName: null,
    angle: 40,
    sendCount: 3,
    hardestSendGrade: 'V5',
    currentClimbName: 'Crux',
    currentClimbGrade: 'V4',
    reasons: ['FOLLOWING_USER'],
    ...overrides,
  };
}

function trackedCalls(event: string) {
  return analytics.track.mock.calls.filter(([name]) => name === event).map(([, props]) => props);
}

describe('HomeSessionSection', () => {
  it('says what starting offers, with one Start button, when there is no recap', () => {
    renderSession();
    expect(screen.getByText('mobile.home.sections.session.startBody')).toBeTruthy();
    expect(screen.getByTestId('home-session-start').textContent).toBe('mobile.home.sections.session.startTitle');
    expect(screen.queryByTestId('home-session-last-workout')).toBeNull();
    expect(screen.queryByTestId('home-session-open')).toBeNull();
  });

  it("shows yesterday's workout and its detail line in place of the start line", () => {
    rememberWorkout('user-1', 1);
    renderSession();
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
    renderSession();
    expect(screen.getByTestId('home-session-last-workout').textContent).toContain(
      'mobile.home.sections.session.lastWorkoutToday',
    );
    cleanup();
    resetEndedWorkoutStoreForTests();
    rememberWorkout('user-1', 3);
    renderSession();
    expect(screen.getByTestId('home-session-last-workout').textContent).toContain(
      'mobile.home.sections.session.lastWorkoutOn {"day":"Sunday"}',
    );
    cleanup();
    resetEndedWorkoutStoreForTests();
    rememberWorkout('user-1', 10);
    renderSession();
    expect(screen.getByTestId('home-session-last-workout').textContent).toContain(
      'mobile.home.sections.session.lastWorkoutOn {"day":"Oct 18"}',
    );
  });

  it("never shows another account's workout", () => {
    rememberWorkout('user-2', 1);
    renderSession();
    expect(screen.queryByTestId('home-session-last-workout')).toBeNull();
    expect(screen.getByText('mobile.home.sections.session.startBody')).toBeTruthy();
  });

  it('shows no workout while the account is unknown', () => {
    rememberWorkout('user-1', 1);
    state.userId = undefined;
    renderSession();
    expect(screen.queryByTestId('home-session-last-workout')).toBeNull();
  });

  it('counts Start as a session prompt and a Home tap, and opens the Session tab', () => {
    renderSession();
    fireEvent.click(screen.getByTestId('home-session-start'));
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/(tabs)/record');
    expect(analytics.track.mock.calls).toEqual([
      ['Live Sessions Shelf Viewed', { surface: 'home_session_card', count: 0, state: 'empty' }],
      ['Start Session Prompt Tapped', { surface: 'home_session_card', variant: 'home_session_card' }],
      ['Home Section Tapped', { section: 'session', target: 'start' }],
    ]);
  });

  it('shows a running session without its timer until the start time loads', () => {
    state.sessionId = 'session-1';
    renderSession();
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
    renderSession();
    expect(screen.getByTestId('session-timer')).toBeTruthy();
    cleanup();
    state.focused = false;
    renderSession();
    expect(screen.queryByTestId('session-timer')).toBeNull();
    cleanup();
    state.focused = true;
    state.backgrounded = true;
    renderSession();
    expect(screen.queryByTestId('session-timer')).toBeNull();
  });
});

describe('HomeSessionSection live state (#7689)', () => {
  it('is the plain Start card when nobody is live, and says so once per focus', () => {
    renderSession();
    expect(screen.getByTestId('home-session-start')).toBeTruthy();
    expect(screen.queryByTestId('home-session-live')).toBeNull();
    expect(state.liveCalls.at(-1)).toEqual({ boardUuid: null, enabled: true });
    expect(trackedCalls('Live Sessions Shelf Viewed')).toEqual([
      { surface: 'home_session_card', count: 0, state: 'empty' },
    ]);
  });

  it('leads with one live session: who, board, how long, what they are on, and two buttons', () => {
    state.liveCards = [liveCard('a')];
    renderSession();
    const live = screen.getByTestId('home-session-live');
    expect(live.textContent).toContain('mobile.liveSessions.live');
    expect(live.textContent).toContain('mobile.liveSessions.elapsed.minutes {"minutes":42}');
    expect(screen.getByText('Anna K.')).toBeTruthy();
    expect(live.textContent).toContain('mobile.liveSessions.boardLine {"board":"Kilter Original","angle":40}');
    expect(live.textContent).toContain('mobile.liveSessions.onClimbGrade {"climb":"Crux","grade":"fmt(V4)"}');
    const join = screen.getByTestId('home-session-join');
    expect(join.textContent).toBe('Join Anna');
    expect(join.getAttribute('data-variant')).toBe('filled');
    const own = screen.getByTestId('home-session-start-own');
    expect(own.textContent).toBe('mobile.home.sections.session.startOwn');
    expect(own.getAttribute('data-variant')).toBe('outlined');
    expect(screen.queryByTestId('home-session-start')).toBeNull();
    expect(screen.queryByTestId('home-session-live-more')).toBeNull();
    expect(trackedCalls('Live Sessions Shelf Viewed')).toEqual([
      { surface: 'home_session_card', count: 1, state: 'loaded' },
    ]);
  });

  it('Join opens the join preview with the card as its source, and counts the tap', () => {
    state.liveCards = [liveCard('a')];
    renderSession();
    fireEvent.click(screen.getByTestId('home-session-join'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/join/[sessionId]',
      params: { sessionId: 'a', source: 'home_session_card' },
    });
    expect(trackedCalls('Live Session Card Tapped')).toEqual([
      { surface: 'home_session_card', reason: 'FOLLOWING_USER', viewerIsMember: false, participantCount: 1 },
    ]);
    expect(trackedCalls('Home Section Tapped')).toEqual([{ section: 'session', target: 'join' }]);
  });

  it('Start my own is one tap to the Session tab', () => {
    state.liveCards = [liveCard('a')];
    renderSession();
    fireEvent.click(screen.getByTestId('home-session-start-own'));
    expect(router.navigate).toHaveBeenCalledWith('/(tabs)/record');
    expect(trackedCalls('Start Session Prompt Tapped')).toEqual([
      { surface: 'home_session_card', variant: 'start_my_own' },
    ]);
    expect(trackedCalls('Home Section Tapped')).toEqual([{ section: 'session', target: 'start' }]);
  });

  it('shows several live sessions as the first one and one line for the rest, opened in place', () => {
    state.liveCards = [
      liveCard('a'),
      liveCard('b', {
        host: { userId: 'ben', displayName: 'Ben', avatarUrl: null },
        participants: [{ userId: 'ben', displayName: 'Ben', avatarUrl: null }],
        followedParticipantIds: ['ben'],
      }),
      liveCard('c', {
        host: { userId: 'cleo', displayName: 'Cleo', avatarUrl: null },
        participants: [{ userId: 'cleo', displayName: 'Cleo', avatarUrl: null }],
        followedParticipantIds: ['cleo'],
      }),
    ];
    renderSession();
    expect(screen.getByTestId('home-session-join').textContent).toBe('Join Anna');
    const more = screen.getByTestId('home-session-live-more');
    expect(more.textContent).toBe('mobile.home.sections.session.moreLive {"count":2}');
    expect(screen.queryAllByTestId('home-session-live-row')).toHaveLength(0);
    fireEvent.click(more);
    const rows = screen.getAllByTestId('home-session-live-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Ben');
    fireEvent.click(rows[1] as HTMLElement);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/join/[sessionId]',
      params: { sessionId: 'c', source: 'home_session_card' },
    });
    expect(trackedCalls('Home Section Tapped')).toEqual([{ section: 'session', target: 'more' }]);
  });

  it('leads with a session someone the viewer follows is on, and skips quiet and own sessions', () => {
    state.liveCards = [
      liveCard('quiet', { participantCount: 0 }),
      liveCard('mine', { viewerIsMember: true }),
      liveCard('board', {
        host: { userId: 'stranger', displayName: 'Sam', avatarUrl: null },
        participants: [{ userId: 'stranger', displayName: 'Sam', avatarUrl: null }],
        followedParticipantIds: [],
        reasons: ['SELECTED_BOARD'],
      }),
      liveCard('friend'),
    ];
    renderSession({ liveBoardUuid: 'board-1' });
    expect(state.liveCalls.at(-1)).toEqual({ boardUuid: 'board-1', enabled: true });
    fireEvent.click(screen.getByTestId('home-session-join'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/join/[sessionId]',
      params: { sessionId: 'friend', source: 'home_session_card' },
    });
    expect(screen.getByTestId('home-session-live-more').textContent).toContain('"count":1');
  });

  it('keeps the verb and drops a name too long for the button', () => {
    state.liveCards = [
      liveCard('a', {
        host: { userId: 'host-a', displayName: 'Maximiliana Rodríguez', avatarUrl: null },
        participants: [{ userId: 'host-a', displayName: 'Maximiliana Rodríguez', avatarUrl: null }],
      }),
    ];
    renderSession();
    expect(screen.getByTestId('home-session-join').textContent).toBe('mobile.home.sections.session.join');
  });

  it('keeps the running-session state while the viewer is in a session, and asks nobody who is live', () => {
    state.sessionId = 'session-1';
    state.liveCards = [liveCard('a')];
    renderSession();
    expect(screen.getByTestId('home-session-open')).toBeTruthy();
    expect(screen.queryByTestId('home-session-live')).toBeNull();
    expect(state.liveCalls).toEqual([]);
    expect(trackedCalls('Live Sessions Shelf Viewed')).toEqual([]);
  });

  it('waits for Home scope, and stops asking while the app is in the background', () => {
    renderSession({ liveEnabled: false });
    expect(state.liveCalls.at(-1)).toEqual({ boardUuid: null, enabled: false });
    expect(trackedCalls('Live Sessions Shelf Viewed')).toEqual([]);
    cleanup();
    state.backgrounded = true;
    renderSession();
    expect(state.liveCalls.at(-1)).toEqual({ boardUuid: null, enabled: false });
  });

  it('falls back to the plain card offline, and reports it', () => {
    state.liveBlocked = 'offline';
    state.liveStatus = 'error';
    renderSession();
    expect(screen.getByTestId('home-session-start')).toBeTruthy();
    expect(trackedCalls('Live Sessions Shelf Viewed')).toEqual([
      { surface: 'home_session_card', count: 0, state: 'offline' },
    ]);
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
