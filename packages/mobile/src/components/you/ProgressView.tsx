import { formatBoardDisplayName } from '@boardsesh/board-config';
import type { RawLayoutPercentage } from '@boardsesh/profile-stats';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, StyleSheet, View, type ScrollViewProps } from 'react-native';
import { ScrollEdgeListReset, type ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import type { useYouProfileData } from '../../lib/graphql/hooks';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { useVariantValue } from '../../theme/variants';
import { ActivityIndicator } from '../ActivityIndicator';
import { Card } from '../Card';
import { ContentRenderMarker } from '../ContentRenderObserver';
import { Icon } from '../Icon';
import { OfflineStateView } from '../OfflineStateView';
import { OnboardingTipBanner } from '../onboarding/OnboardingTipBanner';
import { PressableSurface } from '../PressableSurface';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { ActivityHeatmap } from './ActivityHeatmap';
import { PeriodComparisonCard } from './PeriodComparisonCard';
import { flashRedpointColor, layoutChartColor } from './profile-chart-colors';
import { ProfileBoardOverview, ProfileBoardRow } from './ProfileBoardOverview';
import { StatsSummaryCard } from './StatsSummaryCard';
import { GroupedBarChart, StackedBarChart, TotalAreaChart, type ChartLegendItem } from './YouCharts';

/** Display state shared by the connected tab and its isolated stories. */
export type ProgressViewData = Pick<
  ReturnType<typeof useYouProfileData>,
  | 'activityHeatmap'
  | 'aggregatedFlashRedpointBars'
  | 'aggregatedStackedBars'
  | 'comparisonMode'
  | 'filteredLogbook'
  | 'hardestFlash'
  | 'hardestSend'
  | 'hasActiveFilters'
  | 'loading'
  | 'offline'
  | 'percentile'
  | 'periodComparison'
  | 'refetch'
  | 'refreshing'
  | 'retryTotals'
  | 'selectedBoard'
  | 'setComparisonMode'
  | 'statisticsSummary'
  | 'timeframe'
  | 'totalsStatus'
  | 'vPointsTimeline'
  | 'weeklyBars'
>;

export type ProgressViewProps = {
  data: ProgressViewData;
  topInset: number;
  bottomInset: number;
  nativeRootHeader: boolean;
  listTopOffset: number;
  onScroll?: ScrollViewProps['onScroll'];
  onOpenFilters?: () => void;
  isOwnProfile?: boolean;
  scrollEdge?: ScrollEdgeBackdrop;
  recordTipVisible?: boolean;
  onDismissRecordTip?: () => void;
  betaShelf?: ReactNode;
  boardLinkPrompt?: ReactNode;
};

const dismissNothing = () => {};

type ProgressItem =
  | { kind: 'board'; layout: RawLayoutPercentage; first: boolean; last: boolean; largestCount: number }
  | {
      kind:
        | 'overview'
        | 'expand'
        | 'empty'
        | 'tip'
        | 'progress'
        | 'records'
        | 'comparison'
        | 'filtered-empty'
        | 'calendar'
        | 'activity'
        | 'grades'
        | 'flash'
        | 'points'
        | 'beta';
    };
const keyForProgressItem = (item: ProgressItem) =>
  item.kind === 'board' ? `board-${item.layout.layoutKey}` : item.kind;
const typeForProgressItem = (item: ProgressItem) => item.kind;

export const ProgressView = memo(function ProgressView({
  data,
  topInset,
  betaShelf,
  boardLinkPrompt,
  onOpenFilters,
  isOwnProfile = true,
  scrollEdge,
  bottomInset,
  nativeRootHeader,
  listTopOffset,
  onScroll,
  recordTipVisible = false,
  onDismissRecordTip = dismissNothing,
}: ProgressViewProps) {
  const { t, i18n } = useTranslation('profile');
  const { t: tYou } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, colorScheme, brandColors } = useTheme();
  const collapsedBoardCount = useVariantValue({ liquidGlass: 1, material: 3 });
  const paddingBottom = bottomInset + spacing[6];
  const listRef = useRef<FlashListRef<ProgressItem>>(null);
  const [boardsExpanded, setBoardsExpanded] = useState(false);
  // The all-board total is only a fact once its request succeeded. Until then
  // (loading, failed, offline) the header shows that state instead of a 0, and
  // the "no sends yet" empty state stays hidden.
  const totalsKnown = data.totalsStatus === 'ready';
  const hasSends = totalsKnown && data.statisticsSummary.totalAscents > 0;
  const knownNoSends = totalsKnown && data.statisticsSummary.totalAscents === 0;
  const hasActivity = data.filteredLogbook.length > 0;

  const toggleBoards = useCallback(() => {
    // Removing expanded rows while retaining their old scroll offset lands the
    // reader deep inside the charts. Return to the overview before collapsing.
    if (boardsExpanded) listRef.current?.scrollToOffset({ offset: listTopOffset, animated: false });
    setBoardsExpanded(!boardsExpanded);
  }, [boardsExpanded, listTopOffset]);

  const gradeDistLegend = useMemo<ChartLegendItem[] | undefined>(
    () =>
      data.aggregatedStackedBars?.legend.map((entry) => ({
        label: entry.label,
        color: layoutChartColor(entry.key, colorScheme),
      })),
    [colorScheme, data.aggregatedStackedBars],
  );
  const flashRedpointLegend = useMemo<ChartLegendItem[] | undefined>(
    () =>
      data.aggregatedFlashRedpointBars?.[0]?.values.map((entry) => ({
        label: entry.label,
        color: flashRedpointColor(entry.key, colorScheme),
      })),
    [data.aggregatedFlashRedpointBars, colorScheme],
  );

  const boardLabel =
    data.selectedBoard === 'all' ? tYou('mobile.filter.allBoards') : formatBoardDisplayName(data.selectedBoard);
  const periodLabels = {
    all: t('stats.progress.allTime'),
    lastYear: t('stats.progress.lastYear'),
    lastMonth: t('stats.progress.lastMonth'),
    lastWeek: t('stats.progress.lastWeek'),
    today: t('stats.progress.today'),
    custom: t('stats.progress.custom'),
  };
  const scopeLabel = t('stats.progress.scope', { board: boardLabel, period: periodLabels[data.timeframe] });

  // Every board is a real list item: expansion never nests a growing list inside
  // a ScrollView. Charts are bounded, separate items with stable recycling keys.
  const items = useMemo<ProgressItem[]>(() => {
    const layouts = data.statisticsSummary.layoutPercentages;
    const shown = boardsExpanded ? layouts : layouts.slice(0, collapsedBoardCount);
    const result: ProgressItem[] = [{ kind: 'overview' }];
    shown.forEach((layout, index) =>
      result.push({
        kind: 'board',
        layout,
        first: index === 0,
        last: index === shown.length - 1,
        largestCount: layouts[0]?.count ?? 0,
      }),
    );
    if (layouts.length > collapsedBoardCount) result.push({ kind: 'expand' });
    if (knownNoSends && !hasActivity) result.push({ kind: 'empty' });
    if (recordTipVisible) result.push({ kind: 'tip' });
    if (hasSends || hasActivity || data.hasActiveFilters) {
      result.push({ kind: 'progress' });
      if (data.hardestSend || data.hardestFlash || (data.selectedBoard === 'all' && data.percentile))
        result.push({ kind: 'records' });
      if (data.periodComparison) result.push({ kind: 'comparison' });
      if (!hasActivity) result.push({ kind: 'filtered-empty' });
      if (data.activityHeatmap) result.push({ kind: 'calendar' });
      if (data.weeklyBars) result.push({ kind: 'activity' });
      if (data.aggregatedStackedBars) result.push({ kind: 'grades' });
      if (data.aggregatedFlashRedpointBars) result.push({ kind: 'flash' });
      if (data.vPointsTimeline) result.push({ kind: 'points' });
    }
    if (betaShelf) result.push({ kind: 'beta' });
    return result;
  }, [data, boardsExpanded, collapsedBoardCount, hasActivity, hasSends, knownNoSends, recordTipVisible, betaShelf]);

  const renderItem = useCallback(
    ({ item }: { item: ProgressItem }) => {
      const noAscentData = t('empty.noAscentData');
      switch (item.kind) {
        case 'overview':
          return (
            <ProfileBoardOverview
              summary={data.statisticsSummary}
              status={data.totalsStatus}
              onRetry={data.retryTotals}
              isOwnProfile={isOwnProfile}
            />
          );
        case 'board':
          return (
            <ProfileBoardRow
              layout={item.layout}
              largestCount={item.largestCount}
              first={item.first}
              last={item.last}
            />
          );
        case 'expand':
          return (
            <PressableSurface
              testID="profile-board-expand"
              onPress={toggleBoards}
              feedback="opacity"
              accessibilityState={{ expanded: boardsExpanded }}
              style={styles.expand}
            >
              <Text variant="footnote" color={systemColors.accent}>
                {boardsExpanded
                  ? t('stats.boardOverview.showLess')
                  : t('stats.boardOverview.showAll', { count: data.statisticsSummary.layoutPercentages.length })}
              </Text>
              <Icon name={boardsExpanded ? 'chevron.up' : 'chevron.down'} size={16} color={systemColors.accent} />
            </PressableSurface>
          );
        case 'empty':
          return (
            <>
              {boardLinkPrompt}
              <Text variant="body" color={systemColors.secondaryLabel} style={styles.empty}>
                {isOwnProfile ? t('stats.boardOverview.empty') : t('stats.boardOverview.publicEmpty')}
              </Text>
            </>
          );
        case 'tip':
          return (
            <View style={styles.tipInset}>
              <OnboardingTipBanner
                text={tCommon('mobile.onboarding.tips.record')}
                dismissLabel={tCommon('actions.close')}
                onDismiss={onDismissRecordTip}
                icon="chart.bar"
              />
            </View>
          );
        case 'progress':
          return (
            <View style={styles.progressHeader} testID="profile-progress-section">
              <View style={styles.progressTitle}>
                <Text variant="title3">
                  {isOwnProfile ? t('stats.progress.title') : t('stats.progress.publicTitle')}
                </Text>
                {onOpenFilters ? (
                  <PressableSurface
                    testID="profile-progress-filter"
                    onPress={onOpenFilters}
                    feedback="opacity"
                    accessibilityLabel={t('stats.progress.filters')}
                    style={styles.filterAction}
                  >
                    <Icon
                      name="filter"
                      size={20}
                      color={data.hasActiveFilters ? brandColors.primary : systemColors.label}
                    />
                    <Text variant="footnote" color={systemColors.accent}>
                      {tYou('mobile.filter.title')}
                    </Text>
                  </PressableSurface>
                ) : null}
              </View>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {scopeLabel}
              </Text>
            </View>
          );
        case 'records':
          return (
            <StatsSummaryCard
              hardestSend={data.hardestSend}
              hardestFlash={data.hardestFlash}
              boardLabel={boardLabel}
              percentile={data.selectedBoard === 'all' ? data.percentile : null}
            />
          );
        case 'comparison':
          return (
            <PeriodComparisonCard
              periodComparison={data.periodComparison}
              comparisonMode={data.comparisonMode}
              onComparisonModeChange={data.setComparisonMode}
            />
          );
        case 'filtered-empty':
          return (
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.empty}>
              {t('stats.progress.filteredEmpty')}
            </Text>
          );
        case 'beta':
          return betaShelf ? <>{betaShelf}</> : null;
        case 'calendar':
          return data.activityHeatmap ? (
            <>
              <SectionHeader title={t('stats.calendar')} />
              <Card style={styles.chartCard}>
                <ActivityHeatmap heatmap={data.activityHeatmap} />
              </Card>
            </>
          ) : null;
        case 'activity':
          return (
            <>
              <SectionHeader title={t('stats.progress.activity')} />
              <Card style={styles.chartCard}>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.chartCaption}>
                  {t('stats.progress.activityCaption')}
                </Text>
                <StackedBarChart
                  bars={data.weeklyBars}
                  colorBy="grade"
                  emptyLabel={noAscentData}
                  maxXLabels={6}
                  showYAxisScale
                  accessibilityLabel={t('stats.weeklyAttemptsAria')}
                />
              </Card>
            </>
          );
        case 'grades':
          return (
            <>
              <SectionHeader title={t('stats.gradeDistribution')} />
              <Card style={styles.chartCard}>
                <StackedBarChart
                  bars={data.aggregatedStackedBars?.bars ?? null}
                  colorBy="layout"
                  gradeAxis
                  emptyLabel={noAscentData}
                  legend={gradeDistLegend}
                  showYAxisScale
                  accessibilityLabel={t('stats.gradeDistributionAria')}
                />
              </Card>
            </>
          );
        case 'flash':
          return data.aggregatedFlashRedpointBars ? (
            <>
              <SectionHeader title={t('stats.flashVsRedpoint')} />
              <Card style={styles.chartCard} accessibilityLabel={t('stats.flashRedpointAria')}>
                <GroupedBarChart
                  bars={data.aggregatedFlashRedpointBars}
                  emptyLabel={noAscentData}
                  legend={flashRedpointLegend}
                />
              </Card>
            </>
          ) : null;
        case 'points':
          return data.vPointsTimeline ? (
            <>
              <SectionHeader title={t('stats.vPoints')} />
              <Card style={styles.chartCard}>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.chartCaption}>
                  {t('stats.vPointsTotal', {
                    value: getCachedNumberFormat(i18n.language).format(data.vPointsTimeline.totalPoints),
                  })}
                </Text>
                <TotalAreaChart timeline={data.vPointsTimeline} color={brandColors.primary} emptyLabel={noAscentData} />
              </Card>
            </>
          ) : null;
      }
    },
    [
      data,
      boardsExpanded,
      toggleBoards,
      brandColors.primary,
      systemColors.label,
      systemColors.secondaryLabel,
      t,
      tCommon,
      tYou,
      onDismissRecordTip,
      onOpenFilters,
      isOwnProfile,
      scopeLabel,
      boardLabel,
      betaShelf,
      boardLinkPrompt,
      gradeDistLegend,
      flashRedpointLegend,
      i18n.language,
    ],
  );

  if (data.offline.isBlocked && data.offline.reason) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <OfflineStateView
          effectiveOffline={data.offline.isOffline}
          reason={data.offline.reason}
          errorTitle={tYou('mobile.loadError.progress')}
          onRetry={data.refetch}
        />
      </View>
    );
  }
  if (data.loading) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  return (
    <>
      <ContentRenderMarker route="/profile" count={data.statisticsSummary.totalAscents} />
      {/* The offline and loading branches above unmount the list, and with it
          anything it had scrolled under the header. */}
      <ScrollEdgeListReset edge={scrollEdge} />
      <FlashList
        ref={listRef}
        testID="progress-tab-loaded"
        data={items}
        renderItem={renderItem}
        keyExtractor={keyForProgressItem}
        getItemType={typeForProgressItem}
        maintainVisibleContentPosition={{ disabled: true }}
        {...scrollEdge?.listProps}
        onScroll={onScroll}
        contentInsetAdjustmentBehavior={nativeRootHeader ? 'automatic' : 'never'}
        scrollToOverflowEnabled={nativeRootHeader}
        contentContainerStyle={{ paddingTop: topInset, paddingBottom }}
        scrollIndicatorInsets={{ top: topInset }}
        refreshControl={
          <RefreshControl refreshing={data.refreshing} onRefresh={data.refetch} tintColor={brandColors.primary} />
        }
      />
    </>
  );
});

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chartCard: { marginHorizontal: spacing[4] },
  chartCaption: { marginBottom: spacing[2] },
  tipInset: { marginHorizontal: spacing[4], marginTop: spacing[3] },
  expand: {
    minHeight: 48,
    marginHorizontal: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
  },
  empty: { paddingHorizontal: spacing[4], paddingVertical: spacing[4] },
  progressHeader: { paddingHorizontal: spacing[4], paddingTop: spacing[5], paddingBottom: spacing[3], gap: spacing[1] },
  progressTitle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  filterAction: {
    minHeight: 48,
    paddingHorizontal: spacing[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
});
