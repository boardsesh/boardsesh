// @vitest-environment jsdom
//
// The Progress sub-tab of the Profile tab. On iOS 26 the tab's segmented control
// floats over this list, and the list tells the header, through a store, when
// its rows are under the control. The tab swaps its list for a spinner while
// loading and for an offline placard: the store must not outlive the list.
import { act, render } from '@testing-library/react';
import { createContext, createElement, type ComponentProps, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every prop the mounted list was given.
const list = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));

vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => true }));
vi.mock('expo-router/react-navigation', () => ({ HeaderHeightContext: createContext<number | undefined>(100) }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    list.props = props;
    return createElement('div', { 'data-list': 'true' });
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@boardsesh/key-value-storage', () => ({ ONBOARDING_TIP_RECORD_KEY: 'record-tip' }));
vi.mock('@boardsesh/board-config', () => ({ formatBoardDisplayName: (boardName: string) => boardName }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Card', () => ({ Card: () => null }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-loading': 'true' }),
}));
vi.mock('../../OfflineState', () => ({ OfflineState: () => createElement('div', { 'data-offline': 'true' }) }));
vi.mock('../../ScreenshotSmokeMarker', () => ({ ScreenshotSmokeMarker: () => null }));
vi.mock('../ProfileBetaShelf', () => ({ ProfileBetaShelf: () => null }));
vi.mock('../BoardLinkPrompt', () => ({ BoardLinkPrompt: () => null }));
vi.mock('../ProfileBoardOverview', () => ({ ProfileBoardOverview: () => null, ProfileBoardRow: () => null }));
vi.mock('../StatsSummaryCard', () => ({ StatsSummaryCard: () => null }));
vi.mock('../PeriodComparisonCard', () => ({ PeriodComparisonCard: () => null }));
vi.mock('../YouCharts', () => ({
  StackedBarChart: () => null,
  GroupedBarChart: () => null,
  TotalAreaChart: () => null,
}));
vi.mock('../ActivityHeatmap', () => ({ ActivityHeatmap: () => null }));
vi.mock('../profile-chart-colors', () => ({ layoutChartColor: () => '#000', flashRedpointColor: () => '#000' }));
vi.mock('../../onboarding/OnboardingTipBanner', () => ({ OnboardingTipBanner: () => null }));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: () => Promise.resolve(true),
  markTipSeen: () => Promise.resolve(),
}));
vi.mock('../../../lib/intl-formatter-cache', () => ({
  getCachedNumberFormat: () => ({ format: (value: number) => String(value) }),
}));
vi.mock('../../../lib/showcase-anchor', () => ({
  ShowcaseAnchorView: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 } }));
vi.mock('../../../theme/variants', () => ({ useVariantValue: () => 1 }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {}, colorScheme: 'dark' }),
}));

import { ProgressTab } from '../ProgressTab';
import { createScrollEdgeBackdrop, type ScrollEdgeBackdrop } from '../../../hooks/use-scroll-edge-backdrop';

type ProgressData = ComponentProps<typeof ProgressTab>['data'];

/** A signed-in climber with nothing logged: the smallest list the tab renders. */
function progressData(over: { loading?: boolean; offline?: boolean } = {}): ProgressData {
  return {
    statisticsSummary: { totalAscents: 0, layoutPercentages: [] },
    filteredLogbook: [],
    hasActiveFilters: false,
    selectedBoard: 'all',
    timeframe: 'all',
    offline: { isBlocked: over.offline === true, reason: over.offline ? 'offline' : null },
    loading: over.loading === true,
    refreshing: false,
    refetch: vi.fn(),
  } as unknown as ProgressData;
}

const SCROLL_LISTENERS = [
  'onScroll',
  'onScrollBeginDrag',
  'onScrollEndDrag',
  'onMomentumScrollBegin',
  'onMomentumScrollEnd',
] as const;

function scrollListTo(scrollEdge: ScrollEdgeBackdrop, offsetY: number) {
  scrollEdge.listProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offsetY } } } as Parameters<
    ScrollEdgeBackdrop['listProps']['onScroll']
  >[0]);
}

describe('ProgressTab list under the floating profile header', () => {
  beforeEach(() => {
    list.props = undefined;
  });

  it("gives its list every one of the store's scroll listeners", () => {
    const scrollEdge = createScrollEdgeBackdrop();
    render(<ProgressTab data={progressData()} topInset={52} scrollEdge={scrollEdge} />);

    for (const listener of SCROLL_LISTENERS) expect(list.props?.[listener]).toBe(scrollEdge.listProps[listener]);
  });

  // Under an opaque header the screen passes no store.
  it('gives its list no scroll listeners without a store', () => {
    render(<ProgressTab data={progressData()} topInset={52} />);

    expect(list.props).toBeDefined();
    for (const listener of SCROLL_LISTENERS) expect(list.props?.[listener]).toBeUndefined();
  });

  // Changing the board or the period reloads the tab: the spinner takes the
  // list's place under the same header. What the list had scrolled under the
  // header must go with it, or the blur stays on over the spinner.
  it.each([
    ['loading', { loading: true }, '[data-loading]'],
    ['offline', { offline: true }, '[data-offline]'],
  ] as const)('puts the store at rest when its %s branch takes the list away', (_branch, state, placard) => {
    const scrollEdge = createScrollEdgeBackdrop();
    const { container, rerender } = render(<ProgressTab data={progressData()} topInset={52} scrollEdge={scrollEdge} />);
    act(() => scrollListTo(scrollEdge, 400));
    expect(scrollEdge.isScrolledUnder()).toBe(true);

    rerender(<ProgressTab data={progressData(state)} topInset={52} scrollEdge={scrollEdge} />);

    expect(container.querySelector('[data-list]')).toBeNull();
    expect(container.querySelector(placard)).not.toBeNull();
    expect(scrollEdge.isScrolledUnder()).toBe(false);
  });

  it('starts the list at rest again when it comes back', () => {
    const scrollEdge = createScrollEdgeBackdrop();
    const { container, rerender } = render(
      <ProgressTab data={progressData({ loading: true })} topInset={52} scrollEdge={scrollEdge} />,
    );
    // Something left the store scrolled while no list was mounted.
    act(() => scrollListTo(scrollEdge, 400));

    rerender(<ProgressTab data={progressData()} topInset={52} scrollEdge={scrollEdge} />);

    expect(container.querySelector('[data-list]')).not.toBeNull();
    expect(scrollEdge.isScrolledUnder()).toBe(false);
  });
});
