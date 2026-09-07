// @vitest-environment jsdom
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  type LogbookFilterState,
  type LogbookSortPreset,
} from '@boardsesh/logbook';

// Captures what LogbookTab hands the (mocked) chip row + filter sheet, so the test
// can assert the Liquid-Glass gating, the inline-search layout, and the showSort
// hand-off without native components. The chip row exposes its onSelectPreset +
// onOpenFilters + the committed preset; the sheet exposes its showSort prop.
const captured = vi.hoisted(() => ({
  chipMounted: false,
  chipPreset: undefined as LogbookSortPreset | null | undefined,
  onSelectPreset: null as ((preset: LogbookSortPreset) => void) | null,
  onOpenFilters: null as (() => void) | null,
  chipFilters: undefined as LogbookFilterState | undefined,
  onToggleFacet: null as ((facet: 'grade' | 'angle' | 'show' | 'date') => void) | null,
  onUpdateFilters: null as ((partial: Partial<LogbookFilterState>) => void) | null,
  onSearchChange: null as ((text: string) => void) | null,
  sheetMounted: false,
  sheetShowSort: undefined as boolean | undefined,
}));

// The variant the (mocked) theme reports; flipped per test to drive the gate.
const themeState = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
const flagState = vi.hoisted(() => ({ logbookFilters: true }));
// The platform the gate reads; flipped per test (the chip row is iOS-only).
const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

// Capture the analytics mock so the sort/filter/search instrumentation can be
// asserted (the wrapped handlers track then commit through the real reducer).
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

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

vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  // The gate reads Platform.OS; a getter lets a test flip it per render.
  Platform: {
    get OS() {
      return platformState.os;
    },
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  useWindowDimensions: () => ({ fontScale: 1, width: 375, height: 800 }),
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

vi.mock('../../SearchHeader', () => ({
  SearchHeader: ({ onChangeText }: { onChangeText?: (text: string) => void }) => {
    captured.onSearchChange = onChangeText ?? null;
    return createElement('div', { 'data-testid': 'search-header' });
  },
}));

vi.mock('../LogbookChipRow', () => ({
  LogbookChipRow: ({
    sortPreset,
    onSelectPreset,
    onOpenFilters,
    filters,
    onToggleFacet,
    onUpdateFilters,
  }: {
    sortPreset: LogbookSortPreset | null;
    onSelectPreset: (preset: LogbookSortPreset) => void;
    onOpenFilters: () => void;
    filters: LogbookFilterState;
    onToggleFacet: (facet: 'grade' | 'angle' | 'show' | 'date') => void;
    onUpdateFilters: (partial: Partial<LogbookFilterState>) => void;
  }) => {
    captured.chipMounted = true;
    captured.chipPreset = sortPreset;
    captured.onSelectPreset = onSelectPreset;
    captured.onOpenFilters = onOpenFilters;
    captured.chipFilters = filters;
    captured.onToggleFacet = onToggleFacet;
    captured.onUpdateFilters = onUpdateFilters;
    return createElement('div', { 'data-testid': 'chip-row' });
  },
}));

vi.mock('../LogbookFacetRail', () => ({
  LogbookFacetRail: ({ openFacet }: { openFacet: string | null }) =>
    openFacet ? createElement('div', { 'data-testid': 'facet-rail', 'data-facet': openFacet }) : null,
}));

vi.mock('../LogbookFilterSheet', () => ({
  LogbookFilterSheet: ({ showSort }: { showSort?: boolean }) => {
    captured.sheetMounted = true;
    captured.sheetShowSort = showSort;
    return createElement('div', { 'data-testid': 'filter-sheet' });
  },
}));

vi.mock('../LogbookRow', () => ({ LogbookRow: () => createElement('div') }));
vi.mock('../LogbookDayDivider', () => ({ LogbookDayDivider: () => null }));
vi.mock('../LogbookEntryChooserSheet', () => ({ LogbookEntryChooserSheet: () => null }));
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../BoardLinkPrompt', () => ({ BoardLinkPrompt: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));

vi.mock('../../../lib/graphql/hooks', () => ({
  useUserAscentsFeed: () => feed,
  useUserGroupedAscentsFeed: () => toGroupedFeed(feed as unknown as Record<string, unknown>),
  useGrades: () => ({ data: [] }),
}));
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
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: () => {} }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));
vi.mock('@boardsesh/board-react', () => ({ useDeleteTick: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// onlineManager is what `useIsOffline` (via useOfflineQueryState) reads.
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueriesData: vi.fn() }),
  onlineManager: { isOnline: () => true, subscribe: () => () => {} },
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => (key === 'logbook-filters' ? flagState.logbookFilters : undefined),
}));

// use-logbook-search and @boardsesh/logbook run for real so setPreset commits the
// preset into the feed through the real reducer.
import { LogbookTab } from '../LogbookTab';
import { loadLogbookPrefs } from '../../../lib/logbook-prefs-store';
import { toGroupedFeed } from './helpers/grouped-feed-factory';

beforeEach(() => {
  captured.chipMounted = false;
  captured.chipPreset = undefined;
  captured.onSelectPreset = null;
  captured.onOpenFilters = null;
  captured.chipFilters = undefined;
  captured.onToggleFacet = null;
  captured.onUpdateFilters = null;
  captured.onSearchChange = null;
  captured.sheetMounted = false;
  captured.sheetShowSort = undefined;
  themeState.variant = 'liquidGlass';
  flagState.logbookFilters = true;
  platformState.os = 'ios';
  analytics.track.mockClear();
});

describe('LogbookTab chip row', () => {
  it('renders the chip row with inline search and no separate filter button on iOS Liquid Glass', () => {
    const { getByTestId, queryByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(getByTestId('chip-row')).toBeTruthy();
    expect(getByTestId('search-header')).toBeTruthy();
    expect(captured.chipPreset).toBe('recent');
    expect(captured.chipFilters).toEqual(DEFAULT_LOGBOOK_FILTERS);
    // The filter entry moved into the chip row, so no round filter button here.
    expect(queryByLabelText('mobile.logbook.filter')).toBeNull();
  });

  it("opens the sheet via the chip row's onOpenFilters and hands it showSort={false}", () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.onOpenFilters).not.toBeNull();

    act(() => captured.onOpenFilters?.());
    expect(captured.sheetMounted).toBe(true);
    // Sort lives in the chips, so the sheet drops its Sort block.
    expect(captured.sheetShowSort).toBe(false);
  });

  it('does not render the chip row on Material, keeps the filter button + sheet sort', () => {
    themeState.variant = 'material';
    const { queryByTestId, getByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(queryByTestId('chip-row')).toBeNull();

    fireEvent.click(getByLabelText('mobile.logbook.filter'));
    expect(captured.sheetShowSort).toBe(true);
  });

  it('does not render the chip row on Android, keeps the filter button + sheet sort', () => {
    platformState.os = 'android';
    const { queryByTestId, getByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(queryByTestId('chip-row')).toBeNull();

    fireEvent.click(getByLabelText('mobile.logbook.filter'));
    expect(captured.sheetShowSort).toBe(true);
  });

  it('hides the toolbar and chips when the logbook-filters flag is off', () => {
    flagState.logbookFilters = false;
    const { queryByTestId, queryByLabelText } = render(createElement(LogbookTab, { userId: 'user-1' }));

    expect(queryByTestId('chip-row')).toBeNull();
    expect(queryByLabelText('mobile.logbook.filter')).toBeNull();
  });

  it('commits the selected preset live through setPreset and tracks the sort change', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.onSelectPreset).not.toBeNull();

    // Selecting Hardest commits via the real reducer; the chip re-renders with it.
    act(() => captured.onSelectPreset?.('hardest'));
    expect(captured.chipPreset).toBe('hardest');
    // Privacy-safe: only the preset name is sent.
    expect(analytics.track).toHaveBeenCalledWith('Logbook Sort Changed', { preset: 'hardest' });
  });

  it('toggles the inline facet rail open and closed via onToggleFacet', () => {
    const { queryByTestId } = render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.onToggleFacet).not.toBeNull();
    // Nothing open initially.
    expect(queryByTestId('facet-rail')).toBeNull();

    // Tapping Grade opens its rail.
    act(() => captured.onToggleFacet?.('grade'));
    expect(queryByTestId('facet-rail')?.getAttribute('data-facet')).toBe('grade');

    // Tapping Grade again closes it (toggle).
    act(() => captured.onToggleFacet?.('grade'));
    expect(queryByTestId('facet-rail')).toBeNull();
  });

  it('swaps to a different facet rail (one open at a time)', () => {
    const { queryByTestId } = render(createElement(LogbookTab, { userId: 'user-1' }));
    act(() => captured.onToggleFacet?.('grade'));
    expect(queryByTestId('facet-rail')?.getAttribute('data-facet')).toBe('grade');

    act(() => captured.onToggleFacet?.('angle'));
    expect(queryByTestId('facet-rail')?.getAttribute('data-facet')).toBe('angle');
  });

  it('closes the open facet rail when the filter sheet opens', () => {
    const { queryByTestId } = render(createElement(LogbookTab, { userId: 'user-1' }));
    act(() => captured.onToggleFacet?.('grade'));
    expect(queryByTestId('facet-rail')?.getAttribute('data-facet')).toBe('grade');

    // Opening the full sheet dismisses any open inline rail (no lingering rail
    // under the sheet, no over-tall toolbar after it closes).
    act(() => captured.onOpenFilters?.());
    expect(queryByTestId('facet-rail')).toBeNull();
  });

  it('live-commits a filter patch through onUpdateFilters (the Show menu / rails) and tracks the changed fields', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(captured.onUpdateFilters).not.toBeNull();
    expect(captured.chipFilters?.benchmarkOnly).toBe(false);

    act(() => captured.onUpdateFilters?.({ benchmarkOnly: true }));
    expect(captured.chipFilters?.benchmarkOnly).toBe(true);
    // Privacy-safe: only the changed field NAMES are sent (sorted, comma-joined),
    // never their values.
    expect(analytics.track).toHaveBeenCalledWith('Logbook Filter Changed', { fields: 'benchmarkOnly' });
  });

  it('tracks a committed non-empty search by length only (never the query text)', () => {
    vi.useFakeTimers();
    try {
      render(createElement(LogbookTab, { userId: 'user-1' }));
      expect(captured.onSearchChange).not.toBeNull();

      // Type a term; the commit (and the analytics) fire after the debounce.
      act(() => captured.onSearchChange?.('crimps'));
      expect(analytics.track).not.toHaveBeenCalledWith('Logbook Searched', expect.anything());
      act(() => void vi.runAllTimers());
      // Privacy: only the length is sent, never 'crimps'.
      expect(analytics.track).toHaveBeenCalledWith('Logbook Searched', { length: 6 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not track a search when the committed term is empty', () => {
    vi.useFakeTimers();
    try {
      render(createElement(LogbookTab, { userId: 'user-1' }));
      // Whitespace normalises to '', which is a clear, not a search.
      act(() => captured.onSearchChange?.('   '));
      act(() => void vi.runAllTimers());
      expect(analytics.track).not.toHaveBeenCalledWith('Logbook Searched', expect.anything());
    } finally {
      vi.useRealTimers();
    }
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
