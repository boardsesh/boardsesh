// @vitest-environment jsdom
//
// What the join screen counts and shows for an invite that is not a plain,
// live, first-time join (#6004):
//
//  - `Session Joined` must not fire for someone already in the session;
//  - every dead end (not found, ended, sign-in needed, failed to load, failed
//    to join) fires one `Session Join Outcome`;
//  - a DORMANT session (running, nobody connected) shows the join card, not
//    "Session not found";
//  - a running session whose wall the backend will not name says the host has
//    to be connected, with a retry, and is not "Session not found" either.
//
// The live-session funnel and the plain join stay in
// `join-session-analytics.test.tsx`.
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const auth = vi.hoisted(() => ({ isAuthenticated: true }));
const queue = vi.hoisted(() => ({
  sessionId: null as string | null,
  joinSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
}));
const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn() }));

type PreviewData = {
  id: string;
  boardPath: string;
  endedAt: string | null;
  users: Array<{ id: string; username: string; avatarUrl: null; isLeader: boolean }>;
  invite?: { state: 'live' | 'dormant' | 'host_away' | 'ended'; hostName: string | null };
};

function liveSession(): PreviewData {
  return {
    id: 'session-42',
    boardPath: '/kilter/1/10/1,2/40',
    endedAt: null,
    users: [{ id: 'u1', username: 'host', avatarUrl: null, isLeader: true }],
  };
}

const preview = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  calls: [] as unknown[][],
}));

// Every Button's onPress in render order; the confirmation card's first is Join.
const buttons = vi.hoisted(() => ({ presses: [] as Array<() => void> }));

vi.mock('../../../src/lib/analytics', () => ({ track: analytics.track }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: 'session-42' }),
  useRouter: () => router,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options?.host ? `${key}:${String(options.host)}` : key),
  }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@boardsesh/board-config', () => ({
  parseBoardPath: () => ({ boardName: 'kilter', layoutId: 1, angle: 40 }),
  parseNamedBoardPath: () => null,
  formatBoardDisplayName: () => 'Kilter',
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ onPress, title }: { onPress?: () => void; title?: string }) => {
    if (onPress) buttons.presses.push(onPress);
    return createElement('button', null, title);
  },
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: auth.isAuthenticated }),
}));
vi.mock('../../../src/providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: queue.sessionId }),
  useQueueActions: () => ({ joinSession: queue.joinSession, clearSession: queue.clearSession }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useSessionPreview: (...args: unknown[]) => {
    preview.calls.push(args);
    return preview;
  },
  useMyBoards: () => ({ data: { boards: [] }, refetch: vi.fn(async () => ({ data: { boards: [] } })) }),
  useCreateBoard: () => ({ mutateAsync: vi.fn(async () => ({})) }),
  useBoardBySlug: () => ({ data: null }),
  fetchBoardBySlug: vi.fn(async () => null),
}));
vi.mock('../../../src/lib/board-path-to-user-board', () => ({
  resolveBoardForSession: vi.fn(async () => ({ uuid: 'board-1', boardType: 'kilter', layoutId: 1 })),
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: {}, borderRadius: {} }));

import JoinSessionScreen from '../[sessionId]';

function outcomes(): unknown[][] {
  return analytics.track.mock.calls.filter(([name]) => name === 'Session Join Outcome');
}

beforeEach(() => {
  analytics.track.mockClear();
  auth.isAuthenticated = true;
  queue.sessionId = null;
  queue.joinSession.mockReset();
  queue.joinSession.mockResolvedValue(undefined);
  router.replace.mockClear();
  buttons.presses = [];
  preview.data = liveSession();
  preview.isLoading = false;
  preview.isError = false;
  preview.calls = [];
});

describe('JoinSessionScreen: Session Joined', () => {
  it('does not fire for someone already in the session', async () => {
    queue.sessionId = 'session-42';

    render(createElement(JoinSessionScreen));
    await act(async () => {
      buttons.presses[0]?.();
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/record'));

    expect(analytics.track).not.toHaveBeenCalledWith('Session Joined', expect.anything());
    expect(outcomes()).toEqual([]);
  });

  it('still fires for a genuine join, with no outcome event beside it', async () => {
    render(createElement(JoinSessionScreen));
    await act(async () => {
      buttons.presses[0]?.();
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/record'));

    expect(analytics.track).toHaveBeenCalledWith('Session Joined', {
      session_id: 'session-42',
      sessionId: 'session-42',
      board_name: 'kilter',
      layout_id: 1,
    });
    expect(outcomes()).toEqual([]);
  });
});

describe('JoinSessionScreen: Session Join Outcome', () => {
  it('reports not_found when neither query knows the session', () => {
    preview.data = null;

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.notFound');
    expect(outcomes()).toEqual([
      ['Session Join Outcome', { sessionId: 'session-42', outcome: 'not_found', stage: 'preview' }],
    ]);
  });

  it('reports ended for a session with an end timestamp', () => {
    preview.data = { ...liveSession(), endedAt: '2026-10-05T10:00:00Z' };

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.ended');
    expect(outcomes()).toEqual([
      ['Session Join Outcome', { sessionId: 'session-42', outcome: 'ended', stage: 'preview' }],
    ]);
  });

  it('shows ended, not "not found", for an ended session with nobody connected', () => {
    preview.data = { ...liveSession(), boardPath: '', users: [], invite: { state: 'ended', hostName: null } };

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.ended');
    expect(container.textContent).not.toContain('mobileJoin.notFound');
    expect(outcomes()[0][1]).toEqual({ sessionId: 'session-42', outcome: 'ended', stage: 'preview' });
  });

  it('says the host has to be connected, with a retry, when a running session has no wall to join on', () => {
    preview.data = { ...liveSession(), boardPath: '', users: [], invite: { state: 'host_away', hostName: 'Alex' } };
    preview.refetch.mockClear();

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.hostAway');
    expect(container.textContent).toContain('mobileJoin.hostAwayBody:Alex');
    expect(container.textContent).not.toContain('mobileJoin.notFound');
    expect(container.textContent).not.toContain('mobileJoin.join');
    expect(outcomes()).toEqual([
      ['Session Join Outcome', { sessionId: 'session-42', outcome: 'host_away', stage: 'preview' }],
    ]);

    buttons.presses[0]();
    expect(preview.refetch).toHaveBeenCalledTimes(1);
  });

  it('asks for whoever sent the invite when the host has no name to show', () => {
    preview.data = { ...liveSession(), boardPath: '', users: [], invite: { state: 'host_away', hostName: null } };

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.hostAwayBodyNoHost');
  });

  it('reports sign_in_needed for a signed-out climber', () => {
    auth.isAuthenticated = false;

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.signInToJoin');
    expect(outcomes()).toEqual([
      ['Session Join Outcome', { sessionId: 'session-42', outcome: 'sign_in_needed', stage: 'preview' }],
    ]);
  });

  it('reports error when the invite fails to load', () => {
    preview.data = undefined;
    preview.isError = true;

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.error');
    expect(outcomes()).toEqual([
      ['Session Join Outcome', { sessionId: 'session-42', outcome: 'error', stage: 'preview' }],
    ]);
  });

  it('reports error at the join stage when the join itself fails, and no Session Joined', async () => {
    queue.joinSession.mockRejectedValueOnce(new Error('join failed'));

    render(createElement(JoinSessionScreen));
    await act(async () => {
      buttons.presses[0]?.();
    });
    await waitFor(() => expect(outcomes()).toHaveLength(1));

    expect(outcomes()[0][1]).toEqual({ sessionId: 'session-42', outcome: 'error', stage: 'join' });
    expect(analytics.track).not.toHaveBeenCalledWith('Session Joined', expect.anything());
  });

  it('fires nothing while the invite is loading', () => {
    preview.data = undefined;
    preview.isLoading = true;

    render(createElement(JoinSessionScreen));

    expect(outcomes()).toEqual([]);
  });

  it('counts a dead end once, however often the screen re-renders', () => {
    preview.data = null;

    const { rerender } = render(createElement(JoinSessionScreen));
    rerender(createElement(JoinSessionScreen));
    rerender(createElement(JoinSessionScreen));

    expect(outcomes()).toHaveLength(1);
  });
});

describe('JoinSessionScreen: dormant session', () => {
  const dormant = (): PreviewData => ({
    ...liveSession(),
    users: [],
    invite: { state: 'dormant', hostName: 'Alex' },
  });

  it('asks for the preview with the invite fallback on', () => {
    render(createElement(JoinSessionScreen));

    expect(preview.calls.length).toBeGreaterThan(0);
    for (const call of preview.calls) {
      expect(call).toEqual(['session-42', { inviteFallback: true }]);
    }
  });

  it('shows the join card with the host from the invite, not "Session not found"', () => {
    preview.data = dormant();

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.confirmTitle:Alex');
    expect(container.textContent).toContain('mobileJoin.boardLabelDormant');
    expect(container.textContent).not.toContain('mobileJoin.notFound');
    expect(outcomes()).toEqual([]);
  });

  // The host reconnected mid-load and `session` still had no roster: the card
  // is joinable and must not count an unknown roster as nobody.
  it('shows the join card without a head count for a live invite with no roster', () => {
    preview.data = { ...dormant(), invite: { state: 'live', hostName: 'Alex' } };

    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.confirmTitle:Alex');
    expect(container.textContent).not.toContain('mobileJoin.boardLabel');
    expect(container.textContent).not.toContain('mobileJoin.notFound');
    expect(outcomes()).toEqual([]);
  });

  it('keeps the live count label for a session with people connected', () => {
    const { container } = render(createElement(JoinSessionScreen));

    expect(container.textContent).toContain('mobileJoin.boardLabel');
    expect(container.textContent).not.toContain('mobileJoin.boardLabelDormant');
  });

  it('can be joined, and counts as a join', async () => {
    preview.data = dormant();

    render(createElement(JoinSessionScreen));
    await act(async () => {
      buttons.presses[0]?.();
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/record'));

    expect(queue.joinSession).toHaveBeenCalledWith(
      'session-42',
      expect.objectContaining({ boardPath: '/kilter/1/10/1,2/40' }),
    );
    expect(analytics.track).toHaveBeenCalledWith(
      'Session Joined',
      expect.objectContaining({ session_id: 'session-42' }),
    );
  });
});
