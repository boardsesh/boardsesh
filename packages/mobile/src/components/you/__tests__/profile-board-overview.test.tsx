// @vitest-environment jsdom
import { createElement, useImperativeHandle, type ReactNode, type ComponentProps, type Ref } from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStatisticsSummary } from '@boardsesh/profile-stats';

const scrollToOffset = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    ref,
    data: items,
    renderItem,
    keyExtractor,
    testID,
  }: {
    ref?: Ref<{ scrollToOffset: typeof scrollToOffset }>;
    data: unknown[];
    renderItem: (row: { item: unknown }) => ReactNode;
    keyExtractor: (item: unknown) => string;
    testID?: string;
  }) => {
    useImperativeHandle(ref, () => ({ scrollToOffset }), []);
    return createElement(
      'div',
      { 'data-testid': testID },
      items.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    );
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: { count?: number; board?: string; period?: string; name?: string; grade?: string }) =>
      options?.count != null
        ? `${key}:${options.count}`
        : options?.board
          ? `${options.board} · ${options.period ?? ''}`
          : key,
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#fff',
      secondaryLabel: '#ccc',
      secondaryBackground: '#222',
      separator: '#333',
      fill: '#444',
    },
    brandColors: { primary: '#a78bfa' },
    colorScheme: 'dark',
  }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 80 }),
}));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({ hasSeenTip: async () => true, markTipSeen: vi.fn() }));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    testID,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
    accessibilityState?: { expanded?: boolean };
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'data-testid': testID, 'aria-expanded': accessibilityState?.expanded },
      children,
    ),
}));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h3', null, title),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../OfflineState', () => ({ OfflineState: () => null }));
vi.mock('../../onboarding/OnboardingTipBanner', () => ({ OnboardingTipBanner: () => null }));
vi.mock('../ProfileBetaShelf', () => ({ ProfileBetaShelf: () => null }));
vi.mock('../StatsSummaryCard', () => ({ StatsSummaryCard: () => null }));
vi.mock('../PeriodComparisonCard', () => ({ PeriodComparisonCard: () => null }));
vi.mock('../ActivityHeatmap', () => ({ ActivityHeatmap: () => null }));
vi.mock('../YouCharts', () => ({
  StackedBarChart: () => null,
  GroupedBarChart: () => null,
  TotalAreaChart: () => null,
}));

import { ProgressTab } from '../ProgressTab';
import { ProfileBoardRow } from '../ProfileBoardOverview';

type YouData = ComponentProps<typeof ProgressTab>['data'];
const layoutInputs = [
  {
    layoutKey: 'moonboard-4',
    boardType: 'moonboard',
    layoutId: 4,
    distinctClimbCount: 38,
    gradeCounts: [{ grade: '24', count: 3 }],
  },
  { layoutKey: 'kilter-8', boardType: 'kilter', layoutId: 8, distinctClimbCount: 34, gradeCounts: [] },
  {
    layoutKey: 'moonboard-5',
    boardType: 'moonboard',
    layoutId: 5,
    distinctClimbCount: 32,
    gradeCounts: [{ grade: '22', count: 2 }],
  },
  {
    layoutKey: 'tension-10',
    boardType: 'tension',
    layoutId: 10,
    distinctClimbCount: 28,
    gradeCounts: [{ grade: '23', count: 4 }],
  },
];
function makeData(overrides: Partial<YouData> = {}): YouData {
  return {
    loading: false,
    refreshing: false,
    offline: { isBlocked: false },
    refetch: vi.fn(),
    statisticsSummary: buildStatisticsSummary({ totalDistinctClimbs: 254, layoutStats: layoutInputs }),
    selectedBoard: 'all',
    timeframe: 'all',
    hasActiveFilters: false,
    filteredLogbook: [],
    hardestSend: null,
    hardestFlash: null,
    percentile: null,
    periodComparison: null,
    aggregatedStackedBars: null,
    aggregatedFlashRedpointBars: null,
    activityHeatmap: null,
    weeklyBars: null,
    vPointsTimeline: null,
    ...overrides,
  } as unknown as YouData;
}
afterEach(() => {
  cleanup();
  scrollToOffset.mockClear();
});

describe('all-board profile overview', () => {
  it('uses authoritative distinct totals and expands every named layout without losing them on collapse', () => {
    const { getByText, getByTestId, queryByText } = render(
      <ProgressTab data={makeData()} topInset={100} onOpenFilters={vi.fn()} />,
    );
    expect(getByText('254')).toBeTruthy();
    expect(getByText('stats.boardOverview.layouts:4')).toBeTruthy();
    expect(getByText('MoonBoard Masters 2017')).toBeTruthy();
    expect(getByText('stats.boardOverview.climbs:38')).toBeTruthy();
    expect(getByText('V8')).toBeTruthy();
    expect(queryByText('Tension 2 Mirror')).toBeNull();
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(getByText('Tension 2 Mirror')).toBeTruthy();
    expect(getByTestId('profile-board-expand').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 0, animated: false });
    expect(queryByText('Tension 2 Mirror')).toBeNull();
    expect(getByText('254')).toBeTruthy();
  });

  it('leaves lifetime board records visible under narrowed progress filters and opens the scoped filter', () => {
    const onOpenFilters = vi.fn();
    const { getByText, getByTestId } = render(
      <ProgressTab
        data={makeData({ selectedBoard: 'kilter', timeframe: 'lastWeek', hasActiveFilters: true })}
        topInset={100}
        onOpenFilters={onOpenFilters}
      />,
    );
    expect(getByText('MoonBoard Masters 2017')).toBeTruthy();
    expect(getByText('254')).toBeTruthy();
    expect(getByText('stats.boardOverview.allTime')).toBeTruthy();
    expect(getByText(/Kilter.*stats.progress.lastWeek/)).toBeTruthy();
    fireEvent.click(getByTestId('profile-progress-filter'));
    expect(onOpenFilters).toHaveBeenCalledOnce();
  });

  it('shows a single layout without an expansion control and preserves a missing grade', () => {
    const summary = buildStatisticsSummary({ totalDistinctClimbs: 34, layoutStats: [layoutInputs[1]] });
    const { getByText, queryByTestId, queryByText } = render(
      <ProgressTab data={makeData({ statisticsSummary: summary })} topInset={0} onOpenFilters={vi.fn()} />,
    );
    expect(getByText('Kilter Homewall')).toBeTruthy();
    expect(queryByTestId('profile-board-expand')).toBeNull();
    expect(queryByText('stats.boardOverview.bestSend')).toBeNull();
  });

  it('renders an empty overview without made-up records', () => {
    const { getByText, queryByTestId } = render(
      <ProgressTab
        data={makeData({ statisticsSummary: { totalAscents: 0, layoutPercentages: [] } })}
        topInset={0}
        onOpenFilters={vi.fn()}
      />,
    );
    expect(getByText('0')).toBeTruthy();
    expect(getByText('stats.boardOverview.empty')).toBeTruthy();
    expect(queryByTestId('profile-board-expand')).toBeNull();
  });

  it('uses third-person copy and hides filters when a public profile has no filter sheet', () => {
    const { getByText, queryByTestId } = render(<ProgressTab data={makeData()} topInset={0} isOwnProfile={false} />);
    expect(getByText('stats.boardOverview.publicTitle')).toBeTruthy();
    expect(getByText('stats.progress.publicTitle')).toBeTruthy();
    expect(queryByTestId('profile-progress-filter')).toBeNull();
  });

  it('renders the full layout name and Font record from the shared model', () => {
    const layout = buildStatisticsSummary({ totalDistinctClimbs: 38, layoutStats: [layoutInputs[0]] }, 'font')
      .layoutPercentages[0];
    const { getByText } = render(<ProfileBoardRow layout={layout} largestCount={38} first last />);
    expect(getByText('MoonBoard Masters 2017')).toBeTruthy();
    expect(getByText('7B')).toBeTruthy();
    expect(getByText('7B').getAttribute('data-color')).toBe('#fff');
  });
});
