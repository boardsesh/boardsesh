// @vitest-environment jsdom
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT, type LogbookSortPreset } from '@boardsesh/logbook';

// Captures what LogbookTab hands the (mocked) sort chip row + filter sheet, so the
// test can assert the Liquid-Glass gating and the showSort hand-off without native
// components. The chip row exposes its onSelectPreset + the committed preset; the
// sheet exposes its showSort prop.
const captured = vi.hoisted(() => ({
  chipMounted: false,
  chipPreset: undefined as LogbookSortPreset | undefined,
  onSelectPreset: null as ((preset: LogbookSortPreset) => void) | null,
  sheetMounted: false,
  sheetShowSort: undefined as boolean | undefined,
}));

// The variant the (mocked) theme reports; flipped per test to drive the gate.
const themeState = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
const flagState = vi.hoisted(() => ({ logbookFilters: true }));
// The platform the gate reads; flipped per test (the chip row is iOS-only).
const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

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
  // The gate reads Platform.OS; a getter lets a test flip it per render.
  Platform: {
    get OS() {
      return platformState.os;
    },
  },
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

vi.mock('@shopify/flash-list', () => ({ FlashList: () => createElement('div', { 'data-testid': 'flash-list' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../SearchHeader', () => ({ SearchHeader: () => createElement('div', { 'data-testid': 'search-header' }) }));

vi.mock('../LogbookSortChipRow', () => ({
  LogbookSortChipRow: ({
    preset,
    onSelectPreset,
  }: {
    preset: LogbookSortPreset;
    onSelectPreset: (preset: LogbookSortPreset) => void;
  }) => {
    captured.chipMounted = true;
    captured.chipPreset = preset;
    captured.onSelectPreset = onSelectPreset;
    return createElement('div', { 'data-testid': 'sort-chip-row' });
  },
}));

vi.mock('../LogbookFilterSheet', () => ({
  LogbookFilterSheet: ({ showSort }: { showSort?: boolean }) => {
    captured.sheetMounted = true;
    captured.sheetShowSort = showSort;
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

vi.mock('../../../lib/graphql/hooks', () => ({ useUserAscentsFeed: () => feed }));
vi.mock('../../../lib/logbook-prefs-store', () => ({
  loadLogbookPrefs: vi.fn(() => Promise.resolve(null)),
  saveLogbookPrefs: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {}, variant: themeState.variant }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => (key === 'logbook-filters' ? flagState.logbookFilters : undefined),
}));

// use-logbook-search and @boardsesh/logbook run for real so setPreset commits the
// preset into the feed through the real reducer.
import { LogbookTab } from '../LogbookTab';
import { loadLogbookPrefs } from '../../../lib/logbook-prefs-store';

beforeEach(() => {
  captured.chipMounted = false;
  captured.chipPreset = undefined;
  captured.onSelectPreset = null;
  captured.sheetMounted = false;
  captured.sheetShowSort = undefined;
  themeState.variant = 'liquidGlass';
  flagState.logbookFilters = true;
  platformState.os = 'ios';
});

describe('LogbookTab sort chips', () => {
  it('renders the sort chips and hides the sheet sort on iOS Liquid Glass', () => {
    const { getByTestId, getByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(getByTestId('sort-chip-row')).toBeTruthy();
    expect(captured.chipPreset).toBe('recent');

    // Opening the sheet hands it showSort={false} so sort isn't worded twice.
    fireEvent.click(getByLabelText('mobile.logbook.filter'));
    expect(captured.sheetMounted).toBe(true);
    expect(captured.sheetShowSort).toBe(false);
  });

  it('does not render the sort chips on Material and keeps the sheet sort', () => {
    themeState.variant = 'material';
    const { queryByTestId, getByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(queryByTestId('sort-chip-row')).toBeNull();

    fireEvent.click(getByLabelText('mobile.logbook.filter'));
    expect(captured.sheetShowSort).toBe(true);
  });

  it('does not render the sort chips on Android and keeps the sheet sort', () => {
    platformState.os = 'android';
    const { queryByTestId, getByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(queryByTestId('sort-chip-row')).toBeNull();

    fireEvent.click(getByLabelText('mobile.logbook.filter'));
    expect(captured.sheetShowSort).toBe(true);
  });

  it('hides the toolbar and chips when the logbook-filters flag is off', () => {
    flagState.logbookFilters = false;
    const { queryByTestId, queryByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(queryByTestId('sort-chip-row')).toBeNull();
    expect(queryByLabelText('mobile.logbook.filter')).toBeNull();
  });

  it('commits the selected preset live through setPreset', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.onSelectPreset).not.toBeNull();

    // Selecting Hardest commits via the real reducer; the chip re-renders with it.
    act(() => captured.onSelectPreset?.('hardest'));
    expect(captured.chipPreset).toBe('hardest');
  });

  it('lights no chip when a non-preset (custom) sort is active', async () => {
    vi.mocked(loadLogbookPrefs).mockResolvedValueOnce({
      filters: DEFAULT_LOGBOOK_FILTERS,
      sort: { ...DEFAULT_LOGBOOK_SORT, mode: 'custom' },
    });
    render(createElement(LogbookTab, { userId: 'user-1' }));
    // Flush the persisted-prefs hydration so the custom sort lands in state.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured.chipMounted).toBe(true);
    expect(captured.chipPreset).toBeNull();
  });
});
