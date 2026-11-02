// @vitest-environment jsdom
import {
  createContext,
  createElement,
  useContext,
  useImperativeHandle,
  type ReactNode,
  type ComponentProps,
  type Ref,
} from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { buildStatisticsSummary } from '@boardsesh/profile-stats';
import { reportScreenshotSmokeContent } from '../../../lib/screenshot-smoke';

vi.mock('../../../lib/screenshot-smoke', () => ({ reportScreenshotSmokeContent: vi.fn() }));

const scrollToOffset = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ OS: 'android', select: (options: { android?: unknown }) => options.android }));
const ThemeVariantContext = createContext<'liquidGlass' | 'material'>('liquidGlass');

vi.mock('expo-router/react-navigation', () => ({ HeaderHeightContext: createContext<number | undefined>(undefined) }));
vi.mock('react-native', () => ({
  Platform: platform,
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
    scrollToOverflowEnabled,
    contentInsetAdjustmentBehavior,
  }: {
    ref?: Ref<{ scrollToOffset: typeof scrollToOffset }>;
    data: unknown[];
    renderItem: (row: { item: unknown }) => ReactNode;
    keyExtractor: (item: unknown) => string;
    testID?: string;
    scrollToOverflowEnabled?: boolean;
    contentInsetAdjustmentBehavior?: string;
  }) => {
    useImperativeHandle(ref, () => ({ scrollToOffset }), []);
    return createElement(
      'div',
      {
        'data-testid': testID,
        'data-scroll-to-overflow': String(scrollToOverflowEnabled),
        'data-inset-adjustment': contentInsetAdjustmentBehavior,
      },
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
    variant: useContext(ThemeVariantContext),
    systemColors: {
      label: '#fff',
      accent: '#a78bfa',
      secondaryLabel: '#ccc',
      secondaryBackground: '#222',
      separator: '#333',
      fill: '#444',
    },
    brandColors: { primary: '#a78bfa' },
    textStyles: { largeTitle: { fontSize: 34, lineHeight: 41 } },
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
vi.mock('../BoardLinkPrompt', () => ({
  BoardLinkPrompt: ({ viewerIsOwner, hasNoSends }: { viewerIsOwner: boolean; hasNoSends: boolean }) =>
    viewerIsOwner && hasNoSends ? createElement('span', { 'data-testid': 'board-link-prompt' }) : null,
}));
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
    totalsStatus: 'ready',
    retryTotals: vi.fn(),
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
beforeEach(() => {
  platform.OS = 'android';
});
afterEach(() => {
  cleanup();
  scrollToOffset.mockClear();
});

describe('all-board profile overview', () => {
  it.each([120, 64])('returns to the inset list top under a %i-point native header', (headerHeight) => {
    platform.OS = 'ios';
    const { getByTestId, queryByText } = render(
      <HeaderHeightContext.Provider value={headerHeight}>
        <ProgressTab data={makeData()} topInset={100} />
      </HeaderHeightContext.Provider>,
    );
    expect(getByTestId('progress-tab-loaded').getAttribute('data-scroll-to-overflow')).toBe('true');
    expect(getByTestId('progress-tab-loaded').getAttribute('data-inset-adjustment')).toBe('automatic');
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(scrollToOffset).not.toHaveBeenCalled();
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: -headerHeight, animated: false });
    expect(queryByText('Tension 2 Mirror')).toBeNull();
  });

  it('uses the current native header height when it changes while boards are expanded', () => {
    platform.OS = 'ios';
    const profileData = makeData();
    const renderProgress = (headerHeight: number) => (
      <HeaderHeightContext.Provider value={headerHeight}>
        <ProgressTab data={profileData} topInset={100} />
      </HeaderHeightContext.Provider>
    );
    const { getByTestId, rerender } = render(renderProgress(120));
    fireEvent.click(getByTestId('profile-board-expand'));
    rerender(renderProgress(64));
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: -64, animated: false });
  });

  it('can collapse with a native header outside a header-height provider', () => {
    platform.OS = 'ios';
    const { getByTestId } = render(<ProgressTab data={makeData()} topInset={0} />);
    fireEvent.click(getByTestId('profile-board-expand'));
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: -0, animated: false });
  });

  it.each([
    { os: 'android', variant: 'liquidGlass' },
    { os: 'ios', variant: 'material' },
    { os: 'web', variant: 'material' },
  ] as const)('returns to offset zero without a native header on $os/$variant', ({ os, variant }) => {
    platform.OS = os;
    const { getByTestId } = render(
      <HeaderHeightContext.Provider value={120}>
        <ThemeVariantContext.Provider value={variant}>
          <ProgressTab data={makeData()} topInset={100} />
        </ThemeVariantContext.Provider>
      </HeaderHeightContext.Provider>,
    );
    expect(getByTestId('progress-tab-loaded').getAttribute('data-scroll-to-overflow')).toBe('false');
    expect(getByTestId('progress-tab-loaded').getAttribute('data-inset-adjustment')).toBe('never');
    fireEvent.click(getByTestId('profile-board-expand'));
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 0, animated: false });
  });

  it.each(['liquidGlass', 'material'] as const)(
    'preserves authoritative totals through expansion and collapse in %s',
    (variant) => {
      const { getByText, getByTestId, queryByText } = render(
        <ThemeVariantContext.Provider value={variant}>
          <ProgressTab data={makeData()} topInset={100} />
        </ThemeVariantContext.Provider>,
      );
      expect(getByText('254')).toBeTruthy();
      expect(getByText('stats.boardOverview.layouts:4')).toBeTruthy();
      expect(getByText('MoonBoard Masters 2017')).toBeTruthy();
      expect(getByText('stats.boardOverview.climbs:38')).toBeTruthy();
      expect(getByText('V8')).toBeTruthy();
      expect(queryByText('Kilter Homewall') !== null).toBe(variant === 'material');
      expect(queryByText('MoonBoard Masters 2019') !== null).toBe(variant === 'material');
      expect(queryByText('Tension 2 Mirror')).toBeNull();
      fireEvent.click(getByTestId('profile-board-expand'));
      expect(scrollToOffset).not.toHaveBeenCalled();
      expect(getByText('Tension 2 Mirror')).toBeTruthy();
      expect(getByTestId('profile-board-expand').getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(getByTestId('profile-board-expand'));
      expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 0, animated: false });
      expect(queryByText('Tension 2 Mirror')).toBeNull();
      expect(queryByText('Kilter Homewall') !== null).toBe(variant === 'material');
      expect(getByText('254')).toBeTruthy();
    },
  );

  it('updates collapsed rows and the expansion control when the visual variant changes', () => {
    const summary = buildStatisticsSummary({ totalDistinctClimbs: 72, layoutStats: layoutInputs.slice(0, 2) });
    const profileData = makeData({ statisticsSummary: summary });
    const { rerender, getByTestId, queryByTestId } = render(
      <ThemeVariantContext.Provider value="liquidGlass">
        <ProgressTab data={profileData} topInset={0} />
      </ThemeVariantContext.Provider>,
    );
    expect(getByTestId('profile-board-row-moonboard-4')).toBeTruthy();
    expect(queryByTestId('profile-board-row-kilter-8')).toBeNull();
    expect(getByTestId('profile-board-expand').getAttribute('aria-expanded')).toBe('false');

    rerender(
      <ThemeVariantContext.Provider value="material">
        <ProgressTab data={profileData} topInset={0} />
      </ThemeVariantContext.Provider>,
    );
    expect(getByTestId('profile-board-row-kilter-8')).toBeTruthy();
    expect(queryByTestId('profile-board-expand')).toBeNull();

    rerender(
      <ThemeVariantContext.Provider value="liquidGlass">
        <ProgressTab data={profileData} topInset={0} />
      </ThemeVariantContext.Provider>,
    );
    expect(queryByTestId('profile-board-row-kilter-8')).toBeNull();
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(getByTestId('profile-board-row-kilter-8')).toBeTruthy();
    fireEvent.click(getByTestId('profile-board-expand'));
    expect(queryByTestId('profile-board-row-kilter-8')).toBeNull();
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

  it.each([
    [true, false, true],
    [false, false, false],
    [true, true, false],
  ])(
    'offers board linking only for an unfiltered empty owned profile: owner=%s filters=%s',
    (owner, filtered, visible) => {
      const { queryByTestId } = render(
        <ProgressTab
          data={makeData({ statisticsSummary: { totalAscents: 0, layoutPercentages: [] }, hasActiveFilters: filtered })}
          topInset={0}
          isOwnProfile={owner}
        />,
      );
      expect(queryByTestId('board-link-prompt') !== null).toBe(visible);
    },
  );

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

describe('profile smoke content', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(reportScreenshotSmokeContent).mockClear();
  });

  it('does not claim real content from an empty profile layout', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const summary = buildStatisticsSummary({ totalDistinctClimbs: 0, layoutStats: [] });
    render(<ProgressTab data={makeData({ statisticsSummary: summary })} topInset={0} />);
    expect(reportScreenshotSmokeContent).toHaveBeenCalledWith('/profile', 0);
  });

  it('reports actual ascent content after a populated profile mounts', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const profileData = makeData();
    render(<ProgressTab data={profileData} topInset={0} />);
    expect(reportScreenshotSmokeContent).toHaveBeenCalledWith('/profile', profileData.statisticsSummary.totalAscents);
  });
});

describe('all-board totals before the totals request succeeds (#6918)', () => {
  // What `useYouProfileData` produces when `userProfileStats` has not landed:
  // the summary is built from `null`, so it reads 0 — which must never reach the screen.
  const unknownTotals = buildStatisticsSummary(null);
  const recordsLoaded = {
    statisticsSummary: unknownTotals,
    hardestSend: { difficulty: 30, label: 'V14', status: 'send' as const },
    hardestFlash: { difficulty: 26, label: 'V10', status: 'flash' as const },
  };

  it('shows a retry row instead of "0 climbs sent" when the totals request failed', () => {
    const retryTotals = vi.fn();
    const { getByTestId, queryByText, queryByTestId } = render(
      <ProgressTab data={makeData({ ...recordsLoaded, totalsStatus: 'error', retryTotals })} topInset={0} />,
    );
    expect(getByTestId('profile-board-overview-error').textContent).toContain('stats.boardOverview.totalsError');
    expect(queryByText('0')).toBeNull();
    expect(queryByText('stats.boardOverview.climbsLabel:0')).toBeNull();
    // The "no sends yet" empty state is a claim about the climber, not a fallback.
    expect(queryByText('stats.boardOverview.empty')).toBeNull();
    expect(queryByTestId('board-link-prompt')).toBeNull();
    fireEvent.click(getByTestId('profile-board-overview-retry'));
    expect(retryTotals).toHaveBeenCalledOnce();
  });

  it('shows a skeleton, not a number, while the totals are loading', () => {
    const { getByTestId, queryByText } = render(
      <ProgressTab data={makeData({ ...recordsLoaded, totalsStatus: 'loading' })} topInset={0} />,
    );
    expect(getByTestId('profile-board-overview-loading')).toBeTruthy();
    expect(queryByText('0')).toBeNull();
    expect(queryByText('stats.boardOverview.empty')).toBeNull();
  });

  it('says the totals load when back online instead of showing 0 offline', () => {
    const { getByTestId, queryByText } = render(
      <ProgressTab data={makeData({ ...recordsLoaded, totalsStatus: 'offline' })} topInset={0} />,
    );
    expect(getByTestId('profile-board-overview-offline').textContent).toBe('stats.boardOverview.totalsOffline');
    expect(queryByText('0')).toBeNull();
  });

  it('still shows a real zero and the empty state once the totals say 0', () => {
    const { getByText } = render(
      <ProgressTab data={makeData({ statisticsSummary: unknownTotals, totalsStatus: 'ready' })} topInset={0} />,
    );
    expect(getByText('0')).toBeTruthy();
    expect(getByText('stats.boardOverview.climbsLabel:0')).toBeTruthy();
    expect(getByText('stats.boardOverview.empty')).toBeTruthy();
  });
});
