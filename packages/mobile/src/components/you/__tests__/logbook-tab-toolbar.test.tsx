// @vitest-environment jsdom
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT, type LogbookFilterState } from '@boardsesh/logbook';
import { loadLogbookPrefs } from '../../../lib/logbook-prefs-store';

// Capture the input LogbookTab feeds useUserAscentsFeed on each render, plus the
// props handed to the (mocked) SearchHeader and LogbookFilterSheet so the test can
// drive the toolbar without native components.
const captured = vi.hoisted(() => ({
  feedInput: undefined as unknown,
  feedEnabled: undefined as boolean | undefined,
  onSearchChange: null as ((text: string) => void) | null,
  onApply: null as ((filters: LogbookFilterState, sort: typeof DEFAULT_LOGBOOK_SORT) => void) | null,
  sheetMounted: false,
}));

const feed = vi.hoisted(() => ({
  data: { pages: [{ userAscentsFeed: { items: [] } }] },
  isPending: false,
  isError: false,
  isRefetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => createElement('div', { 'data-testid': 'flash-list' }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// SearchHeader: surface its onChangeText so the test can type into the toolbar.
vi.mock('../../SearchHeader', () => ({
  SearchHeader: ({ onChangeText }: { onChangeText: (text: string) => void }) => {
    captured.onSearchChange = onChangeText;
    return createElement('div', { 'data-testid': 'search-header' });
  },
}));

// LogbookFilterSheet: capture onApply and record that it mounted (opened).
vi.mock('../LogbookFilterSheet', () => ({
  LogbookFilterSheet: ({
    onApply,
  }: {
    onApply: (filters: LogbookFilterState, sort: typeof DEFAULT_LOGBOOK_SORT) => void;
  }) => {
    captured.onApply = onApply;
    captured.sheetMounted = true;
    return createElement('div', { 'data-testid': 'filter-sheet' });
  },
}));

vi.mock('../LogbookRow', () => ({ LogbookRow: () => createElement('div') }));
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../ScreenTitle', () => ({
  ScreenTitle: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));

// Real feed hook capture: record the input arg + the enabled gate each render.
vi.mock('../../../lib/graphql/hooks', () => ({
  useUserAscentsFeed: (_userId: string | undefined, input: unknown, options?: { enabled?: boolean }) => {
    captured.feedInput = input;
    captured.feedEnabled = options?.enabled;
    return feed;
  },
}));

// Deterministic hydration: no persisted prefs, resolves on a microtask.
vi.mock('../../../lib/logbook-prefs-store', () => ({
  loadLogbookPrefs: vi.fn(() => Promise.resolve(null)),
  saveLogbookPrefs: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {}, brandColors: {} }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));

// use-logbook-search and @boardsesh/logbook are intentionally NOT mocked, so the
// reducer + toAscentFeedInput run for real and the test asserts the real wiring.

import { LogbookTab } from '../LogbookTab';

beforeEach(() => {
  vi.useFakeTimers();
  captured.feedInput = undefined;
  captured.onSearchChange = null;
  captured.onApply = null;
  captured.sheetMounted = false;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('LogbookTab toolbar', () => {
  it('starts with the default Latest preset (recent, desc) and no name', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.feedInput).toMatchObject({ sortBy: 'recent', sortOrder: 'desc' });
    expect(captured.feedInput).not.toHaveProperty('climbName');
  });

  it('commits the debounced search name into the feed input after 300ms', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.onSearchChange).not.toBeNull();

    act(() => {
      captured.onSearchChange?.('crimps');
    });
    // Before the debounce elapses, the name is not yet in the query.
    expect(captured.feedInput).not.toHaveProperty('climbName');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(captured.feedInput).toMatchObject({ climbName: 'crimps' });
  });

  it('opens the filter sheet from the amber filter button', () => {
    const { getByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.sheetMounted).toBe(false);

    fireEvent.click(getByLabelText('mobile.logbook.filter'));
    expect(captured.sheetMounted).toBe(true);
  });

  it('gates the feed until persisted prefs hydrate, then opens it', async () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    // Before hydration the feed is disabled, so it never fetches with defaults
    // (the guard against a default-then-persisted double fetch).
    expect(captured.feedEnabled).toBe(false);
    // Flush the mocked loadLogbookPrefs microtask → hydrate → gate opens.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured.feedEnabled).toBe(true);
  });

  it('still opens the feed when hydration rejects (no deadlock)', async () => {
    vi.mocked(loadLogbookPrefs).mockRejectedValueOnce(new Error('storage down'));
    render(createElement(LogbookTab, { userId: 'user-1' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured.feedEnabled).toBe(true);
  });

  it('applies sheet filters/sort into the feed input', () => {
    const { getByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));
    fireEvent.click(getByLabelText('mobile.logbook.filter'));
    expect(captured.onApply).not.toBeNull();

    // Apply attempts-only + the Hardest preset.
    const filters: LogbookFilterState = { ...DEFAULT_LOGBOOK_FILTERS, includeSends: false, includeAttempts: true };
    act(() => captured.onApply?.(filters, { ...DEFAULT_LOGBOOK_SORT, mode: 'preset', preset: 'hardest' }));

    expect(captured.feedInput).toMatchObject({ statusMode: 'attempt', sortBy: 'hardest' });
  });
});
