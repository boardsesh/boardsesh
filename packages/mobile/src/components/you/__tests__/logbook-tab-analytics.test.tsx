// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

// Capture the per-row onActivate LogbookTab wires up, so the test can fire a tap
// without a real list renderer.
const row = vi.hoisted(() => ({ onPress: null as (() => void) | null }));

const feed = vi.hoisted(() => ({
  data: {
    pages: [
      {
        userAscentsFeed: {
          items: [
            {
              uuid: 'ascent-1',
              climbUuid: 'climb-1',
              status: 'send',
              comment: 'so good',
              climbedAt: '2026-06-15T10:00:00.000Z',
              boardType: 'kilter',
              layoutId: 1,
              angle: 40,
              boardDisplayName: 'Test Board',
            },
          ],
        },
      },
    ],
  },
  isPending: false,
  isRefetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  Pressable: () => null,
  useWindowDimensions: () => ({ fontScale: 1, width: 375, height: 800 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (specifics: Record<string, unknown>) => specifics.ios ?? specifics.default },
}));

// Render every list row (dividers included) through renderItem with its index,
// so the mocked LogbookRow mounts and captures its onPress.
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
  }: {
    data: Array<unknown>;
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
  }) => createElement('div', null, ...data.map((item, index) => renderItem({ item, index }))),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../LogbookRow', () => ({
  LogbookRow: ({
    onActivate,
    ascent,
  }: {
    onActivate: (ascent: { climbUuid: string }) => void;
    ascent: { climbUuid: string };
  }) => {
    row.onPress = () => onActivate(ascent);
    return createElement('div');
  },
}));
vi.mock('../LogbookDayDivider', () => ({ LogbookDayDivider: () => null }));
vi.mock('../LogbookEntryChooserSheet', () => ({ LogbookEntryChooserSheet: () => null }));
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../BoardLinkPrompt', () => ({ BoardLinkPrompt: () => null }));
vi.mock('../LogbookFilterSheet', () => ({ LogbookFilterSheet: () => null }));
vi.mock('../../SearchHeader', () => ({ SearchHeader: () => null }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));

vi.mock('../../../lib/graphql/hooks', () => ({
  useUserAscentsFeed: () => feed,
  useUserGroupedAscentsFeed: () => toGroupedFeed(feed as unknown as Record<string, unknown>),
  useGrades: () => ({ data: [] }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: () => {} }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));
vi.mock('@boardsesh/board-react', () => ({ useDeleteTick: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn(async () => false) }));
// Pin the flags explicitly: kill switch off, filters off — the suite must
// not silently change code path if a provider default ever moves.
vi.mock('../../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => undefined }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// onlineManager is what `useIsOffline` (via useOfflineQueryState) reads.
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueriesData: vi.fn() }),
  onlineManager: { isOnline: () => true, subscribe: () => () => {} },
}));

import { LogbookTab } from '../LogbookTab';
import { toGroupedFeed } from './helpers/grouped-feed-factory';

beforeEach(() => {
  analytics.track.mockClear();
  row.onPress = null;
});

describe('LogbookTab analytics', () => {
  it('fires "Logbook Row Clicked" with the climb uuid + row context when a row is tapped', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(row.onPress).not.toBeNull();

    row.onPress?.();

    // rowIndex counts ENTRIES only — the day divider above the entry (built by
    // the real buildLogbookListRows) must not skew position funnels.
    expect(analytics.track).toHaveBeenCalledWith('Logbook Row Clicked', {
      climbUuid: 'climb-1',
      rowIndex: 0,
      hasNote: true,
      status: 'send',
      grouped: false,
      groupSize: 1,
    });
  });
});
