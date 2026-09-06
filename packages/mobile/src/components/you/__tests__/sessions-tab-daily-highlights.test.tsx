// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression guard for #4975: the Sessions tab must ask for daily highlights.
// Sessions are optional in Boardsesh — the large majority of ticks carry no
// `session_id` — and `sessionGroupedFeed` only synthesises the `daily:<user>:<date>`
// groups that surface those climbs when `includeDailyHighlights` is true. Without
// it the tab showed "No sessions yet" to climbers with thousands of logged ascents.
const captured = vi.hoisted(() => ({
  feedInputs: [] as unknown[],
}));

const feed = vi.hoisted(() => ({
  data: { pages: [{ sessionGroupedFeed: { sessions: [] } }] },
  isPending: false,
  isRefetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'preview-uuid' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn() }),
}));

vi.mock('../../../lib/feed-time-buckets', () => ({
  bucketSessionsByRecency: () => [],
  dedupeSessionsById: (sessions: unknown[]) => sessions,
}));

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
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useSessionGroupedFeed: (input: unknown) => {
    captured.feedInputs.push(input);
    return feed;
  },
  useBulkVoteSummaries: () => ({ data: [] }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 5: 20 },
  borderRadius: { full: 999, md: 8 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));

import { SessionsTab } from '../SessionsTab';

beforeEach(() => {
  captured.feedInputs = [];
});

describe('SessionsTab feed input', () => {
  it('requests daily highlights so session-less ticks still appear', () => {
    render(createElement(SessionsTab, { userId: 'user-1' }));

    expect(captured.feedInputs.length).toBeGreaterThan(0);
    expect(captured.feedInputs[0]).toEqual({ userId: 'user-1', includeDailyHighlights: true });
  });

  it('keeps the flag on when viewing another climber', () => {
    render(createElement(SessionsTab, { userId: 'user-2', topInset: 40 }));

    expect(captured.feedInputs[0]).toEqual({ userId: 'user-2', includeDailyHighlights: true });
  });
});
