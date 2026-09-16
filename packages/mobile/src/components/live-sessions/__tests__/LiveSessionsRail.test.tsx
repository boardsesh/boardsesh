// @vitest-environment jsdom
//
// Render states of Home's "Climbing now" rail. The tiles themselves are stubbed
// to testid markers: this file is about WHICH tiles and rows the rail shows for
// each data state, the analytics it fires, and where a tap goes. The rules
// behind the choices are unit-tested in live-session-model.test.ts.
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { LiveCardModel } from '../live-session-model';

type FakeQuery = {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isSuccess: boolean;
  data: LiveCardModel[] | undefined;
  refetch: () => void;
};

const state = vi.hoisted(() => ({
  query: null as unknown as FakeQuery,
  offline: { isOffline: false, isBlocked: false, reason: null as string | null },
  collapse: { expanded: true, loaded: true },
  impressions: { days: [] as string[], loaded: true },
  queueSessionId: null as string | null,
  followingCount: 5 as number | undefined,
  hookArgs: [] as Array<[string | null, boolean]>,
}));
const spies = vi.hoisted(() => ({
  track: vi.fn(),
  push: vi.fn(),
  navigate: vi.fn(),
  toggle: vi.fn(),
  record: vi.fn(),
  reset: vi.fn(),
  refetch: vi.fn(),
  invite: vi.fn(),
  cardPress: null as null | ((card: unknown) => void),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-testid': 'rail-header' }, children),
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    keyExtractor: (item: unknown) => string;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'rail-list' },
      data.map((item, index) => createElement('div', { key: keyExtractor(item) }, renderItem({ item, index }))),
    ),
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844, scale: 3 }),
}));
vi.mock('expo-router', () => ({
  useIsFocused: () => true,
  useRouter: () => ({ push: spies.push, navigate: spies.navigate }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count != null ? `${key}:${options.count}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SectionDisclosureChevron', () => ({ SectionDisclosureChevron: () => null }));
vi.mock('../../../lib/analytics', () => ({ track: spies.track }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));
vi.mock('../../../lib/live-sessions-collapse', () => ({
  useLiveSessionsCollapse: () => ({ ...state.collapse, toggle: spies.toggle }),
}));
vi.mock('../../../lib/ble/bluetooth-status-store', () => ({ useBluetoothConnectedStatus: () => false }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../lib/graphql/hooks/use-live-sessions', () => ({
  useFollowedLiveSessions: (boardUuid: string | null, enabled: boolean) => {
    state.hookArgs.push([boardUuid, enabled]);
    return state.query;
  },
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'viewer', displayName: 'Vic Viewer', avatarUrl: null } }),
}));
vi.mock('../../../lib/graphql/hooks/use-social', () => ({
  usePublicProfile: () => ({
    data: state.followingCount == null ? undefined : { followingCount: state.followingCount },
  }),
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({ useOfflineQueryState: () => state.offline }));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: state.queueSessionId }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 } }));
vi.mock('../LiveSessionCard', () => ({
  LiveSessionCard: ({ card, onPress }: { card: LiveCardModel; onPress: (card: LiveCardModel) => void }) =>
    createElement('button', { 'data-testid': `card-${card.sessionId}`, onClick: () => onPress(card) }),
}));
vi.mock('../FindClimbersTile', () => ({
  FindClimbersTile: ({ onPress }: { onPress: () => void }) =>
    createElement('button', { 'data-testid': 'find-tile', onClick: onPress }),
}));
vi.mock('../StartSessionTile', () => ({
  StartSessionTile: ({ onPress }: { onPress: (variant: string) => void }) =>
    createElement('button', { 'data-testid': 'start-tile', onClick: () => onPress('default') }),
  StartSessionRow: ({ onPress }: { onPress: () => void }) =>
    createElement('button', { 'data-testid': 'start-row', onClick: onPress }),
}));
vi.mock('../LiveRailStates', () => ({
  LiveRailSkeleton: () => createElement('div', { 'data-testid': 'skeleton' }),
  LiveRailErrorRow: ({ onRetry }: { onRetry: () => void }) =>
    createElement('button', { 'data-testid': 'error-row', onClick: onRetry }),
  LiveRailOfflineRow: () => createElement('div', { 'data-testid': 'offline-row' }),
}));
vi.mock('../LiveDot', () => ({ useLivePulseDriver: vi.fn() }));
vi.mock('../use-minute-tick', () => ({ useMinuteTick: () => 1000 }));
vi.mock('../use-live-session-colors', () => ({ useLiveSessionColors: () => ({ live: '#FBBF24' }) }));
vi.mock('../start-prompt-quiet-days', () => ({
  isStartPromptCollapsed: (days: string[]) => days.length >= 3,
  localDayKey: () => '2026-09-16',
  recordStartPromptImpression: spies.record,
  resetStartPromptImpressions: spies.reset,
  useStartPromptImpressions: () => state.impressions,
}));

import { LiveSessionsRail } from '../LiveSessionsRail';

function card(sessionId: string, overrides: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    sessionId,
    startedAtMs: 0,
    host: null,
    participants: [],
    participantCount: 2,
    followedParticipantIds: ['someone'],
    viewerIsMember: false,
    boardName: 'Kilter Original',
    boardType: 'kilter',
    gymName: null,
    angle: 40,
    sendCount: 0,
    hardestSendGrade: null,
    currentClimbName: null,
    currentClimbGrade: null,
    reasons: ['FOLLOWING_USER'],
    ...overrides,
  };
}

function success(cards: LiveCardModel[]): FakeQuery {
  return { status: 'success', fetchStatus: 'idle', isSuccess: true, data: cards, refetch: spies.refetch };
}

function renderRail(boardUuid: string | null = null) {
  return render(createElement(LiveSessionsRail, { boardUuid, enabled: true, onInvite: spies.invite }));
}

function shelfViewedCalls() {
  return spies.track.mock.calls.filter(([event]) => event === SHARED_EVENTS.LiveSessionsShelfViewed);
}

beforeEach(() => {
  for (const spy of [spies.track, spies.push, spies.navigate, spies.toggle, spies.record, spies.reset, spies.refetch]) {
    spy.mockReset();
  }
  state.query = success([]);
  state.offline = { isOffline: false, isBlocked: false, reason: null };
  state.collapse = { expanded: true, loaded: true };
  state.impressions = { days: [], loaded: true };
  state.queueSessionId = null;
  state.followingCount = 5;
  state.hookArgs = [];
});

describe('LiveSessionsRail states', () => {
  it('shows two skeleton tiles while loading and fires no shelf event', () => {
    state.query = {
      status: 'pending',
      fetchStatus: 'fetching',
      isSuccess: false,
      data: undefined,
      refetch: spies.refetch,
    };
    const { queryByTestId } = renderRail();
    expect(queryByTestId('skeleton')).not.toBeNull();
    expect(queryByTestId('rail-list')).toBeNull();
    expect(shelfViewedCalls()).toHaveLength(0);
  });

  it('shows only the offline row with no signal', () => {
    state.query = {
      status: 'pending',
      fetchStatus: 'paused',
      isSuccess: false,
      data: undefined,
      refetch: spies.refetch,
    };
    state.offline = { isOffline: true, isBlocked: true, reason: 'offline' };
    const { queryByTestId } = renderRail();
    expect(queryByTestId('offline-row')).not.toBeNull();
    expect(queryByTestId('start-tile')).toBeNull();
    expect(shelfViewedCalls()[0]?.[1]).toEqual({ surface: 'home_rail', count: 0, state: 'offline' });
    expect(spies.record).not.toHaveBeenCalled();
  });

  it('shows the error row with Start after it, and retries', () => {
    state.query = { status: 'error', fetchStatus: 'idle', isSuccess: false, data: undefined, refetch: spies.refetch };
    state.offline = { isOffline: false, isBlocked: true, reason: 'error' };
    const { getByTestId, queryByTestId } = renderRail();
    expect(queryByTestId('start-tile')).not.toBeNull();
    fireEvent.click(getByTestId('error-row'));
    expect(spies.refetch).toHaveBeenCalled();
    expect(shelfViewedCalls()[0]?.[1]).toEqual({ surface: 'home_rail', count: 0, state: 'error' });
  });

  it('treats an unreachable backend as an error, not as no signal', () => {
    state.query = {
      status: 'pending',
      fetchStatus: 'paused',
      isSuccess: false,
      data: undefined,
      refetch: spies.refetch,
    };
    state.offline = { isOffline: true, isBlocked: true, reason: 'backend_unreachable' };
    const { queryByTestId } = renderRail();
    expect(queryByTestId('error-row')).not.toBeNull();
    expect(queryByTestId('offline-row')).toBeNull();
  });

  it('shows Start then Find climbers when nobody is live, and counts the impression', () => {
    const { getByTestId } = renderRail();
    const list = getByTestId('rail-list');
    const tiles = Array.from(list.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid'));
    expect(tiles).toEqual(['start-tile', 'find-tile']);
    expect(shelfViewedCalls()[0]?.[1]).toEqual({ surface: 'home_rail', count: 0, state: 'empty' });
    expect(spies.record).toHaveBeenCalledWith('2026-09-16');
  });

  it('leads with Find climbers for someone who follows nobody', () => {
    state.followingCount = 0;
    const { getByTestId } = renderRail();
    const tiles = Array.from(getByTestId('rail-list').querySelectorAll('[data-testid]')).map((node) =>
      node.getAttribute('data-testid'),
    );
    expect(tiles).toEqual(['find-tile', 'start-tile']);
  });

  it('shows one session with Start after it and no live count', () => {
    state.query = success([card('a')]);
    const { getByTestId, container } = renderRail();
    const tiles = Array.from(getByTestId('rail-list').querySelectorAll('[data-testid]')).map((node) =>
      node.getAttribute('data-testid'),
    );
    expect(tiles).toEqual(['card-a', 'start-tile']);
    expect(container.textContent).not.toContain('mobile.liveSessions.liveCount');
    expect(spies.reset).toHaveBeenCalled();
  });

  it('shows many sessions with the live count', () => {
    state.query = success([card('a'), card('b'), card('c')]);
    const { container } = renderRail();
    expect(container.textContent).toContain('mobile.liveSessions.liveCount:3');
    expect(shelfViewedCalls()[0]?.[1]).toEqual({ surface: 'home_rail', count: 3, state: 'loaded' });
  });

  it('shrinks Start to the compact row after quiet days', () => {
    state.impressions = { days: ['2026-09-12', '2026-09-13', '2026-09-14'], loaded: true };
    const { queryByTestId } = renderRail();
    expect(queryByTestId('start-row')).not.toBeNull();
    expect(queryByTestId('start-tile')).toBeNull();
    expect(queryByTestId('find-tile')).toBeNull();
  });

  it('renders only the header when folded, and does not fetch', () => {
    state.collapse = { expanded: false, loaded: true };
    const { queryByTestId } = renderRail('board-1');
    expect(queryByTestId('rail-list')).toBeNull();
    expect(queryByTestId('skeleton')).toBeNull();
    expect(state.hookArgs.at(-1)).toEqual(['board-1', false]);
  });
});

describe('LiveSessionsRail taps', () => {
  it('sends a card tap to the join preview with its source', () => {
    state.query = success([card('a', { reasons: ['FOLLOWED_BOARD'], participantCount: 3 })]);
    const { getByTestId } = renderRail();
    fireEvent.click(getByTestId('card-a'));
    expect(spies.track).toHaveBeenCalledWith(SHARED_EVENTS.LiveSessionCardTapped, {
      surface: 'home_rail',
      reason: 'FOLLOWED_BOARD',
      viewerIsMember: false,
      participantCount: 3,
    });
    expect(spies.push).toHaveBeenCalledWith({
      pathname: '/join/[sessionId]',
      params: { sessionId: 'a', source: 'home_rail' },
    });
  });

  it('opens the Record tab for the session this phone is in', () => {
    state.queueSessionId = 'mine';
    state.query = success([card('mine', { viewerIsMember: true })]);
    const { getByTestId } = renderRail();
    fireEvent.click(getByTestId('card-mine'));
    expect(spies.navigate).toHaveBeenCalledWith('/(tabs)/record');
    expect(spies.push).not.toHaveBeenCalled();
  });

  it('resets quiet days and tracks the Start prompt', () => {
    const { getByTestId } = renderRail();
    fireEvent.click(getByTestId('start-tile'));
    expect(spies.reset).toHaveBeenCalled();
    expect(spies.track).toHaveBeenCalledWith(SHARED_EVENTS.StartSessionPromptTapped, {
      surface: 'home_rail',
      variant: 'default',
    });
    expect(spies.navigate).toHaveBeenCalledWith('/(tabs)/record');
  });

  it('sends Find climbers to climber search', () => {
    const { getByTestId } = renderRail();
    fireEvent.click(getByTestId('find-tile'));
    expect(spies.push).toHaveBeenCalledWith('/users/search');
  });
});
