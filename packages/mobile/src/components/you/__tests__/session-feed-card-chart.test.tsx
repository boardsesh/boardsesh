// @vitest-environment jsdom
import { createElement, useEffect, type ReactNode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionFeedItem, SessionFeedTickHighlight } from '@boardsesh/shared-schema';
import { SessionFeedCard } from '../SessionFeedCard';

type ViewProps = {
  children?: ReactNode;
  pointerEvents?: string;
  onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
};

type FlatListProps<T> = {
  data: T[];
  renderItem: (args: { item: T; index: number }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
};

const chartProps = vi.hoisted(() => ({
  latest: null as Record<string, unknown> | null,
  pageKeys: [] as string[],
}));

vi.mock('react-native', () => ({
  View: ({ children, pointerEvents, onLayout }: ViewProps) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 320 } } });
    }, [onLayout]);
    return createElement('div', { 'data-pointer-events': pointerEvents ?? '' }, children);
  },
  FlatList: <T,>({ data, renderItem, keyExtractor }: FlatListProps<T>) => {
    chartProps.pageKeys = data.map((item) => (item as { key?: string }).key ?? '');
    return createElement(
      'div',
      null,
      data.map((item, index) =>
        createElement('div', { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })),
      ),
    );
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/profile-stats', () => ({ formatTickRelativeTime: () => 'now' }));
vi.mock('@boardsesh/play-view', () => ({ getGradeTextColor: () => '#000000' }));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', null) }));
vi.mock('../../ClimbListThumbnail', () => ({
  ClimbListThumbnail: () => createElement('span', null),
  THUMBNAIL_WIDTH: 76,
  THUMBNAIL_HEIGHT: 96,
}));
vi.mock('../AvatarGroup', () => ({ AvatarGroup: () => createElement('span', null) }));
vi.mock('../FeedSocialRow', () => ({ FeedSocialRow: () => createElement('span', null) }));
vi.mock('../YouCharts', () => ({
  StackedBarChart: (props: Record<string, unknown>) => {
    chartProps.latest = props;
    return createElement('div', { 'data-testid': 'session-chart' });
  },
}));
vi.mock('../profile-chart-colors', () => ({
  gradeBadgeColor: () => '#DC2626',
  buildSessionGradeBars: () => [],
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryLabel: '#666666',
      tertiaryLabel: '#888888',
      separator: '#dddddd',
      fill: '#eeeeee',
    },
    brandColors: {
      primary: '#2563eb',
      success: '#047857',
      warning: '#B45309',
      error: '#DC2626',
    },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 },
  borderRadius: { full: 999, md: 8 },
  overlays: { scrim: 'rgba(0,0,0,0.6)', onScrim: '#ffffff' },
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/beta-video-url', () => ({
  isInstagramUrl: (url: string) => url.includes('instagram.com'),
  isTikTokUrl: (url: string) => url.includes('tiktok.com'),
  mapBetaLink: (row: {
    climbUuid: string;
    link: string;
    foreignUsername: string | null;
    angle: number | null;
    thumbnail: string | null;
    isListed: boolean | null;
    createdAt: string;
    tickUuid?: string | null;
    boardId?: number | null;
  }) => ({
    climb_uuid: row.climbUuid,
    link: row.link,
    foreign_username: row.foreignUsername,
    angle: row.angle,
    thumbnail: row.thumbnail,
    is_listed: row.isListed ?? false,
    created_at: row.createdAt,
    tick_uuid: row.tickUuid ?? null,
    board_id: row.boardId ?? null,
  }),
}));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: () => null }));

function tick(overrides?: Partial<SessionFeedTickHighlight>): SessionFeedTickHighlight {
  return {
    uuid: 'tick-1',
    userId: 'user-1',
    climbUuid: 'climb-1',
    climbName: 'Moon Dust',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    status: 'send',
    attemptCount: 3,
    difficultyName: 'V4',
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    climbedAt: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
}

function session(overrides?: Partial<SessionFeedItem>): SessionFeedItem {
  return {
    sessionId: 'session-1',
    sessionType: 'party',
    participants: [],
    totalSends: 3,
    totalFlashes: 1,
    totalAttempts: 2,
    tickCount: 5,
    gradeDistribution: [{ grade: 'V4', flash: 1, send: 2, attempt: 0 }],
    boardTypes: ['kilter'],
    hardestGrade: 'V4',
    hardestSend: null,
    featuredBeta: null,
    socialEntityType: 'session',
    socialEntityId: 'session-1',
    firstTickAt: '2026-06-12T00:00:00.000Z',
    lastTickAt: '2026-06-12T00:00:00.000Z',
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
    ...overrides,
  };
}

describe('SessionFeedCard chart', () => {
  it('keeps the embedded chart from stealing the card press target', async () => {
    chartProps.pageKeys = [];
    const { getByTestId } = render(
      createElement(SessionFeedCard, {
        session: session(),
        onOpenComments: vi.fn(),
        onPress: vi.fn(),
      }),
    );

    await waitFor(() => expect(getByTestId('session-chart')).toBeTruthy());
    expect(getByTestId('session-chart').parentElement?.getAttribute('data-pointer-events')).toBe('none');
    expect(chartProps.latest?.fitYAxisToData).toBe(true);
    expect(chartProps.latest?.interactive).toBe(false);
    expect(chartProps.latest?.zoomable).toBe(false);
  });

  it('orders the session story as hardest send, beta, then chart', async () => {
    chartProps.pageKeys = [];
    render(
      createElement(SessionFeedCard, {
        session: session({
          hardestSend: tick(),
          featuredBeta: {
            tick: tick({ uuid: 'tick-2', climbName: 'Beta Climb' }),
            betaLink: {
              climbUuid: 'climb-2',
              link: 'https://www.instagram.com/reel/demo/',
              foreignUsername: 'setter',
              angle: 40,
              thumbnail: null,
              isListed: true,
              createdAt: '2026-06-12T00:00:00.000Z',
              tickUuid: 'tick-2',
              boardId: null,
            },
          },
        }),
        onOpenComments: vi.fn(),
        onPress: vi.fn(),
      }),
    );

    await waitFor(() => expect(chartProps.pageKeys).toEqual(['hardest', 'beta', 'chart']));
  });
});
