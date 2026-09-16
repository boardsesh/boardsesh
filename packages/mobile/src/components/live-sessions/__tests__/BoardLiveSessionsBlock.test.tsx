// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { LiveCardModel } from '../live-session-model';

type FakeQuery = { status: string; fetchStatus: string; isSuccess: boolean; data: LiveCardModel[] | undefined };

const state = vi.hoisted(() => ({
  query: null as unknown as FakeQuery,
  offline: { isOffline: false, isBlocked: false, reason: null as string | null },
  queueSessionId: null as string | null,
}));
const spies = vi.hoisted(() => ({ track: vi.fn(), push: vi.fn(), navigate: vi.fn(), close: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({ router: { push: spies.push, navigate: spies.navigate } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${Object.values(options).join('|')})` : key,
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../you/AvatarGroup', () => ({ AvatarGroup: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../lib/analytics', () => ({ track: spies.track }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));
vi.mock('../../../lib/graphql/hooks/use-live-sessions', () => ({ useBoardLiveSessions: () => state.query }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'viewer', displayName: 'Vic Viewer', avatarUrl: null } }),
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({ useOfflineQueryState: () => state.offline }));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: state.queueSessionId }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12, full: 999 },
}));
vi.mock('../LiveDot', () => ({ LiveDot: () => null, useLivePulseDriver: vi.fn() }));
vi.mock('../use-elapsed-clock', () => ({ useElapsedClock: () => 42 * 60_000, startedAtKeyFor: () => '' }));
vi.mock('../LiveBadges', () => ({
  LiveActionPill: ({ label }: { label: string }) => createElement('span', null, label),
  LiveGradeChip: ({ label }: { label: string }) => createElement('span', { 'data-testid': 'grade-chip' }, label),
}));
vi.mock('../use-live-session-colors', () => ({ useLiveSessionColors: () => ({}) }));

import { BoardLiveSessionsBlock } from '../BoardLiveSessionsBlock';

function card(sessionId: string, overrides: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    sessionId,
    startedAtMs: 0,
    host: { userId: 'h', displayName: 'Sam Lee', avatarUrl: null },
    participants: [{ userId: 'h', displayName: 'Sam Lee', avatarUrl: null }],
    participantCount: 1,
    followedParticipantIds: [],
    viewerIsMember: false,
    boardName: 'Kilter Original',
    boardType: 'kilter',
    gymName: null,
    angle: 40,
    sendCount: 3,
    hardestSendGrade: 'V5',
    currentClimbName: null,
    currentClimbGrade: null,
    reasons: ['SELECTED_BOARD'],
    ...overrides,
  };
}

function success(cards: LiveCardModel[]): FakeQuery {
  return { status: 'success', fetchStatus: 'idle', isSuccess: true, data: cards };
}

function renderBlock(props: Partial<Parameters<typeof BoardLiveSessionsBlock>[0]> = {}) {
  return render(
    createElement(BoardLiveSessionsBlock, {
      boardId: 7,
      holderName: null,
      holderUserId: null,
      onBeforeNavigate: spies.close,
      ...props,
    }),
  );
}

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset();
  spies.close.mockResolvedValue(true);
  state.query = success([]);
  state.offline = { isOffline: false, isBlocked: false, reason: null };
  state.queueSessionId = null;
});

describe('BoardLiveSessionsBlock', () => {
  it('renders nothing while loading, so the sheet does not jump', () => {
    state.query = { status: 'pending', fetchStatus: 'fetching', isSuccess: false, data: undefined };
    const { container } = renderBlock();
    expect(container.textContent).toBe('');
    expect(spies.track).not.toHaveBeenCalled();
  });

  it('renders nothing on error or offline', () => {
    state.query = { status: 'error', fetchStatus: 'idle', isSuccess: false, data: undefined };
    state.offline = { isOffline: false, isBlocked: true, reason: 'error' };
    const { container } = renderBlock();
    expect(container.textContent).toBe('');
    expect(spies.track).toHaveBeenCalledWith(SHARED_EVENTS.LiveSessionsShelfViewed, {
      surface: 'board_sheet',
      count: 0,
      state: 'error',
    });
  });

  it('invites the climber to start one when nobody is in a session', async () => {
    const { getByTestId, container } = renderBlock();
    expect(container.textContent).toContain('mobile.liveSessions.board.emptyTitle');
    expect(container.textContent).toContain('mobile.liveSessions.board.emptyBody');
    fireEvent.click(getByTestId('board-live-sessions-start'));
    expect(spies.track).toHaveBeenCalledWith(SHARED_EVENTS.StartSessionPromptTapped, {
      surface: 'board_sheet',
      variant: 'board_sheet',
    });
    expect(spies.close).toHaveBeenCalled();
    await waitFor(() => expect(spies.navigate).toHaveBeenCalledWith('/(tabs)/record'));
  });

  it('names who is on the wall, unless it is the viewer', () => {
    const { container, unmount } = renderBlock({ holderName: 'Jonah W.', holderUserId: 'jonah' });
    expect(container.textContent).toContain('mobile.liveSessions.board.emptyBodyLitBy(Jonah W.)');
    unmount();

    const self = renderBlock({ holderName: 'Vic Viewer', holderUserId: 'viewer' });
    expect(self.container.textContent).not.toContain('emptyBodyLitBy');
  });

  it('renders nothing when the viewer is already in a session and nobody else is live', () => {
    state.queueSessionId = 'mine';
    const { container } = renderBlock();
    expect(container.textContent).toBe('');
  });

  it('lists up to three sessions and counts the rest', () => {
    state.query = success([card('a'), card('b'), card('c'), card('d'), card('e')]);
    const { getAllByTestId, container } = renderBlock();
    expect(getAllByTestId('board-live-session-row')).toHaveLength(3);
    expect(container.textContent).toContain('mobile.liveSessions.board.more(2)');
    expect(container.textContent).toContain('mobile.liveSessions.actions.join');
    expect(spies.track).toHaveBeenCalledWith(SHARED_EVENTS.LiveSessionsShelfViewed, {
      surface: 'board_sheet',
      count: 5,
      state: 'loaded',
    });
  });

  it('waits for the sheet to finish closing, then opens the join preview from a row', async () => {
    let settle: (proceed: boolean) => void = () => {};
    spies.close.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    state.query = success([card('a')]);
    const { getByTestId } = renderBlock();
    fireEvent.click(getByTestId('board-live-session-row'));
    // A second tap while the sheet is still leaving must not queue another push.
    fireEvent.click(getByTestId('board-live-session-row'));
    expect(spies.close).toHaveBeenCalledTimes(1);
    expect(spies.push).not.toHaveBeenCalled();

    settle(true);
    await waitFor(() => expect(spies.push).toHaveBeenCalledTimes(1));
    expect(spies.push).toHaveBeenCalledWith({
      pathname: '/join/[sessionId]',
      params: { sessionId: 'a', source: 'board_sheet' },
    });
    expect(spies.track).toHaveBeenCalledWith(SHARED_EVENTS.LiveSessionCardTapped, {
      surface: 'board_sheet',
      reason: 'SELECTED_BOARD',
      viewerIsMember: false,
      participantCount: 1,
    });
  });

  it('does not navigate when the sheet handoff was aborted', async () => {
    spies.close.mockResolvedValue(false);
    state.query = success([card('a')]);
    const { getByTestId } = renderBlock();
    fireEvent.click(getByTestId('board-live-session-row'));
    await waitFor(() => expect(spies.close).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spies.push).not.toHaveBeenCalled();
  });

  it('says Open on the session this phone is in and routes to Record', async () => {
    state.queueSessionId = 'mine';
    state.query = success([card('mine', { viewerIsMember: true })]);
    const { getByTestId, container } = renderBlock();
    expect(container.textContent).toContain('mobile.liveSessions.actions.open');
    fireEvent.click(getByTestId('board-live-session-row'));
    await waitFor(() => expect(spies.navigate).toHaveBeenCalledWith('/(tabs)/record'));
  });

  it('shows the hardest grade as a chip, not plain text in the meta line', () => {
    state.query = success([card('a')]);
    const { getByTestId } = renderBlock();
    expect(getByTestId('grade-chip').textContent).toBe('V5');
  });

  it('keeps its rows when a later poll fails', () => {
    state.query = { status: 'error', fetchStatus: 'idle', isSuccess: false, data: [card('a')] };
    const { getAllByTestId } = renderBlock();
    expect(getAllByTestId('board-live-session-row')).toHaveLength(1);
  });
});
