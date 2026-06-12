// @vitest-environment jsdom
import { render, act } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Captures every `now` value SessionsTab feeds into the recency bucketing, plus
// the RefreshControl onRefresh handler the test fires. Regression guard for
// A5-you-profile-005: the Sessions clock must re-evaluate on pull-to-refresh
// (and on focus) instead of staying frozen at mount.
const captured = vi.hoisted(() => ({
  bucketNows: [] as number[],
  onRefresh: null as (() => void) | null,
}));

type SessionsFeedData = {
  pages: Array<{
    sessionGroupedFeed: {
      sessions: Array<{ sessionId: string; lastTickAt: string }>;
    };
  }>;
};

const feed = vi.hoisted(() => ({
  data: {
    pages: [{ sessionGroupedFeed: { sessions: [{ sessionId: 's1', lastTickAt: '2026-06-04T09:00:00.000Z' }] } }],
  } as SessionsFeedData | undefined,
  isPending: false,
  isRefetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', testID ? { 'data-testid': testID } : null, children),
  // Expose onRefresh so the test can fire a pull-to-refresh without a real list.
  RefreshControl: ({ onRefresh }: { onRefresh?: () => void }) => {
    captured.onRefresh = onRefresh ?? null;
    return null;
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    refreshControl,
    ListFooterComponent,
  }: {
    refreshControl?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => createElement('div', null, refreshControl, ListFooterComponent),
}));

// Capture the injected clock; return a single section so a header renders.
vi.mock('../../../lib/feed-time-buckets', () => ({
  bucketSessionsByRecency: (sessions: Array<{ sessionId: string }>, now: number) => {
    captured.bucketNows.push(now);
    return sessions.length > 0 ? [{ bucket: 'today', sessions }] : [];
  },
  dedupeSessionsById: (sessions: unknown[]) => sessions,
}));

// Run the focus effect once on mount (mirrors first focus, runs after render —
// not during it — so a setNow inside the effect can't loop). The test asserts
// on the refresh-driven change.
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), navigate: vi.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => effect(), []);
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../SessionFeedCard', () => ({ SessionFeedCard: () => null }));
vi.mock('../SessionsFeedHeader', () => ({ SessionsFeedHeader: () => null }));
vi.mock('../FeedSectionLabel', () => ({ FeedSectionLabel: () => null }));
vi.mock('../CommentSheet', () => ({ CommentSheet: () => null }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({ Button: () => null }));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'activity-indicator' }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useSessionGroupedFeed: () => feed,
  useBulkVoteSummaries: () => ({ data: [] }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));

import { SessionsTab } from '../SessionsTab';

beforeEach(() => {
  captured.bucketNows = [];
  captured.onRefresh = null;
  feed.data = {
    pages: [{ sessionGroupedFeed: { sessions: [{ sessionId: 's1', lastTickAt: '2026-06-04T09:00:00.000Z' }] } }],
  };
  feed.isPending = false;
  feed.isRefetching = false;
  feed.isFetchingNextPage = false;
  feed.hasNextPage = false;
  feed.refetch.mockReset();
  feed.fetchNextPage.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionsTab clock (A5-you-profile-005)', () => {
  it('re-evaluates `now` on pull-to-refresh so buckets track the wall clock', () => {
    vi.setSystemTime(new Date('2026-06-04T23:50:00.000Z'));
    render(createElement(SessionsTab, { userId: 'user-1' }));

    const mountNow = captured.bucketNows.at(-1);
    expect(mountNow).toBe(Date.parse('2026-06-04T23:50:00.000Z'));
    expect(captured.onRefresh).not.toBeNull();

    // Advance the wall clock past midnight, then pull to refresh.
    vi.setSystemTime(new Date('2026-06-05T00:10:00.000Z'));
    act(() => {
      captured.onRefresh?.();
    });

    // With the fix, refreshing updates `now`; without it `now` stays frozen at
    // mount and this stays equal to mountNow.
    const refreshedNow = captured.bucketNows.at(-1);
    expect(refreshedNow).toBe(Date.parse('2026-06-05T00:10:00.000Z'));
    expect(refreshedNow).not.toBe(mountNow);
  });
});

describe('SessionsTab loading state', () => {
  it('renders feed skeleton content instead of a spinner while the first page loads', () => {
    feed.data = undefined;
    feed.isPending = true;

    const { queryByTestId, queryAllByTestId } = render(createElement(SessionsTab, { userId: 'user-1' }));

    expect(queryByTestId('activity-indicator')).toBeNull();
    expect(queryAllByTestId('session-feed-skeleton-card')).toHaveLength(3);
  });

  it('renders feed skeleton content instead of a spinner while the next page loads', () => {
    feed.isFetchingNextPage = true;

    const { queryByTestId, queryAllByTestId } = render(createElement(SessionsTab, { userId: 'user-1' }));

    expect(queryByTestId('activity-indicator')).toBeNull();
    expect(queryAllByTestId('session-feed-skeleton-card')).toHaveLength(1);
  });
});
