// @vitest-environment jsdom
//
// Issue #6665: a session's tick plays from the session's ticks, like a row of
// any list. The list-play hook has its own suite; here the screen only has to
// hand it the session's ticks, in order, and wire its tap onto every row.
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type TickListOptions = { sourceId: string; label: string; rows: readonly { uuid: string }[] };

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  options: undefined as TickListOptions | undefined,
  rowProps: [] as { tick: { uuid: string }; onPress: unknown }[],
  session: null as null | Record<string, unknown>,
  routeId: 'session-1',
  cardProps: undefined as undefined | { onEditSession?: unknown; onOpenComments?: unknown },
  editSheetRendered: false,
  voteArgs: undefined as undefined | unknown[],
}));

vi.mock('../../../lib/playlists/use-tick-list-activation', () => ({
  useTickListActivation: (options: TickListOptions) => {
    mocks.options = options;
    return mocks.open;
  },
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: mocks.routeId }),
  useNavigation: () => ({ setOptions: vi.fn() }),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => createElement('div', null, ListHeaderComponent, ...data.map((item, index) => renderItem({ item, index }))),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/profile-stats', () => ({ formatTickAbsoluteTime: () => 'Oct 1, 2026' }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../you/CommentSheet', () => ({ CommentSheet: () => null }));
vi.mock('../SessionSummaryCard', () => ({
  SessionSummaryCard: (props: { onEditSession?: unknown; onOpenComments?: unknown }) => {
    mocks.cardProps = props;
    return null;
  },
  SessionNotesCard: () => null,
}));
vi.mock('../SessionEditSheet', () => ({
  SessionEditSheet: () => {
    mocks.editSheetRendered = true;
    return null;
  },
}));
vi.mock('../SessionAnalyticsSection', () => ({ SessionAnalyticsSection: () => null }));
vi.mock('../SessionBetaCarousel', () => ({ SessionBetaCarousel: () => null }));
vi.mock('../SessionLeaderboard', () => ({ SessionLeaderboard: () => null }));
vi.mock('../SessionTickRow', () => ({
  SessionTickRow: (props: { tick: { uuid: string }; onPress: unknown }) => {
    mocks.rowProps.push(props);
    return null;
  },
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useSessionDetail: () => ({ data: mocks.session, isPending: false }),
  useBulkVoteSummaries: (...args: unknown[]) => {
    mocks.voteArgs = args;
    return { data: [] };
  },
  useProfile: () => ({ data: { id: 'user-1' } }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ floatingControlBottom: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12, 6: 24, 8: 32 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../lib/grade-label', () => ({ getSoleBoardType: () => 'kilter' }));

import SessionDetailScreen from '../SessionDetailScreen';

beforeEach(() => {
  mocks.open.mockReset();
  mocks.options = undefined;
  mocks.rowProps = [];
  mocks.routeId = 'session-1';
  mocks.cardProps = undefined;
  mocks.editSheetRendered = false;
  mocks.voteArgs = undefined;
  mocks.session = {
    sessionId: 'session-1',
    sessionType: 'party',
    ownerUserId: 'user-1',
    sessionName: 'Tuesday',
    lastTickAt: '2026-10-01T10:00:00.000Z',
    participants: [{ userId: 'user-1' }],
    boardTypes: ['kilter'],
    gradeDistribution: [],
    ticks: [
      { uuid: 'tick-1', userId: 'user-1', climbUuid: 'climb-1' },
      { uuid: 'tick-2', userId: 'user-1', climbUuid: 'climb-2' },
    ],
  };
});

describe('SessionDetailScreen tick taps', () => {
  it("plays a tick from the session's ticks, in the order listed", () => {
    render(createElement(SessionDetailScreen));

    expect(mocks.options).toMatchObject({ sourceId: 'session:session-1', label: 'playView.track.sessionClimbs' });
    expect(mocks.options?.rows.map(({ uuid }) => uuid)).toEqual(['tick-1', 'tick-2']);
  });

  it("wires the hook's tap onto every row", () => {
    render(createElement(SessionDetailScreen));

    expect(mocks.rowProps.map(({ tick }) => tick.uuid)).toEqual(['tick-1', 'tick-2']);
    for (const props of mocks.rowProps) expect(props.onPress).toBe(mocks.open);
  });
});

describe('SessionDetailScreen social and edit actions (#5290)', () => {
  it('offers edit, likes and comments on a real session the viewer owns', () => {
    render(createElement(SessionDetailScreen));

    expect(mocks.cardProps?.onEditSession).toBeTypeOf('function');
    expect(mocks.cardProps?.onOpenComments).toBeTypeOf('function');
    expect(mocks.editSheetRendered).toBe(true);
    expect(mocks.voteArgs).toEqual(['session', ['session-1'], true]);
  });

  it('hides edit, likes and comments on a daily group', () => {
    mocks.routeId = 'daily:user-1:2026-09-06';
    mocks.session = { ...mocks.session, sessionId: 'daily:user-1:2026-09-06', sessionType: 'daily_highlight' };
    render(createElement(SessionDetailScreen));

    expect(mocks.cardProps?.onEditSession).toBeUndefined();
    expect(mocks.cardProps?.onOpenComments).toBeUndefined();
    expect(mocks.editSheetRendered).toBe(false);
    expect(mocks.voteArgs).toEqual(['session', [], false]);
  });
});
