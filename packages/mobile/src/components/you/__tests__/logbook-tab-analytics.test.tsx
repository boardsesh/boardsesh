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
          items: [{ uuid: 'ascent-1', climbUuid: 'climb-1' }],
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
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (specifics: Record<string, unknown>) => specifics.ios ?? specifics.default },
}));

// Render every data row through renderItem so the mocked LogbookRow mounts and
// captures its onPress.
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
  }: {
    data: Array<{ uuid: string }>;
    renderItem: (info: { item: { uuid: string } }) => ReactNode;
  }) => createElement('div', null, ...data.map((item) => renderItem({ item }))),
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
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../LogbookFilterSheet', () => ({ LogbookFilterSheet: () => null }));
vi.mock('../../SearchHeader', () => ({ SearchHeader: () => null }));
vi.mock('../../ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../lib/graphql/hooks', () => ({ useUserAscentsFeed: () => feed }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));

import { LogbookTab } from '../LogbookTab';

beforeEach(() => {
  analytics.track.mockClear();
  row.onPress = null;
});

describe('LogbookTab analytics', () => {
  it('fires "Logbook Row Clicked" with the climb uuid when a row is tapped', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(row.onPress).not.toBeNull();

    row.onPress?.();

    expect(analytics.track).toHaveBeenCalledWith('Logbook Row Clicked', { climbUuid: 'climb-1' });
  });
});
