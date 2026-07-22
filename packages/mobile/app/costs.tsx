import { memo, useCallback, useMemo, useState } from 'react';
import { Stack } from 'expo-router';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { LineChart } from 'react-native-gifted-charts';
import type { RunningCostsMonth } from '@boardsesh/shared-schema';
import { ActivityIndicator } from '../src/components/ActivityIndicator';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { SectionHeader } from '../src/components/SectionHeader';
import { Text } from '../src/components/Text';
import { useBottomChromeMetrics } from '../src/hooks/use-bottom-chrome-metrics';
import { useStackScreenOptions } from '../src/hooks/use-stack-screen-options';
import { SPONSORS_URL } from '../src/lib/acknowledgements';
import { useRunningCosts } from '../src/lib/graphql/hooks/use-running-costs';
import { getCachedDateTimeFormat, getCachedNumberFormat } from '../src/lib/intl-formatter-cache';
import { openExternalUrl } from '../src/lib/open-url';
import { useTheme } from '../src/providers/theme-provider';
import { borderRadius, spacing } from '../src/theme/tokens';

const CHART_HEIGHT = 180;
const AXIS_LABEL_SIZE = 11;
const MAX_X_LABELS = 6;

// Categorical colours for the by-category breakdown. Plain hex strings (never
// PlatformColor), mirroring `profile-chart-colors.ts` so gifted-charts-adjacent
// marks stay renderer-safe; distinct hues keep hosting / AI / domain / other
// readable side by side on both the M3 white and dark violet cards.
const COST_CATEGORY_COLORS: Record<string, Record<'light' | 'dark', string>> = {
  hosting: { light: '#0284C7', dark: '#38BDF8' },
  ai: { light: '#7E22CE', dark: '#C084FC' },
  domain: { light: '#16A34A', dark: '#4ADE80' },
  other: { light: '#B45309', dark: '#FBBF24' },
};

function categoryColor(category: string, colorScheme: 'light' | 'dark', fallback: string): string {
  return COST_CATEGORY_COLORS[category]?.[colorScheme] ?? fallback;
}

/** 'YYYY-MM' → short month label, adding a 2-digit year at year boundaries. */
function buildMonthLabels(months: RunningCostsMonth[], locale: string): string[] {
  const monthFormatter = getCachedDateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  let previousYear: number | null = null;
  return months.map((entry) => {
    const [yearText, monthText] = entry.month.split('-');
    const year = Number(yearText);
    const monthIndex = Number(monthText) - 1;
    const date = new Date(Date.UTC(year, monthIndex, 1));
    const shortMonth = monthFormatter.format(date);
    const showYear = previousYear === null || previousYear !== year;
    previousYear = year;
    return showYear ? `${shortMonth} '${yearText.slice(-2)}` : shortMonth;
  });
}

type CostPoint = { value: number; label: string };

/**
 * Filled cost-over-time area chart. Reuses the `TotalAreaChart` visual language
 * (curved filled `LineChart`, chart-safe string colours from `theme.chartColors`,
 * `isAnimated={false}`) but labels the axis in real currency for the transparency
 * screen. Chart data is memoized; the component is memoized so queue churn on the
 * screen never re-runs the gifted-charts layout.
 */
const CostOverTimeChart = memo(function CostOverTimeChart({
  points,
  formatAxis,
}: {
  points: CostPoint[];
  formatAxis: (dollars: number) => string;
}) {
  const { chartColors, colorScheme } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width), []);

  const model = useMemo(() => {
    const step = points.length > MAX_X_LABELS ? Math.ceil(points.length / MAX_X_LABELS) : 1;
    const maxValue = Math.max(...points.map((point) => point.value), 1);
    const sections = 4;
    const yAxisLabelTexts = Array.from({ length: sections + 1 }, (_, index) =>
      formatAxis((maxValue * index) / sections),
    );
    const data = points.map((point, index) => ({
      value: point.value,
      label: index % step === 0 ? point.label : '',
      hideDataPoint: index !== points.length - 1,
      dataPointColor: chartColors.accent,
      dataPointRadius: 4,
    }));
    return { data, maxValue, sections, yAxisLabelTexts };
  }, [points, formatAxis, chartColors.accent]);

  const lineSpacing = width > 0 ? Math.max(1, Math.floor((width - 48) / Math.max(1, points.length - 1))) : 1;

  return (
    <View style={{ height: CHART_HEIGHT }} onLayout={onLayout}>
      {width > 0 ? (
        <LineChart
          areaChart
          data={model.data}
          width={width - 48}
          height={CHART_HEIGHT - 28}
          spacing={lineSpacing}
          initialSpacing={4}
          endSpacing={spacing[4]}
          color={chartColors.accent}
          startFillColor={chartColors.accent}
          endFillColor={chartColors.accent}
          startOpacity={colorScheme === 'dark' ? 0.55 : 0.42}
          endOpacity={colorScheme === 'dark' ? 0.1 : 0.04}
          gradientDirection="vertical"
          thickness={2}
          curved
          curvature={0.2}
          maxValue={model.maxValue}
          noOfSections={model.sections}
          yAxisLabelTexts={model.yAxisLabelTexts}
          yAxisThickness={0}
          xAxisThickness={StyleSheet.hairlineWidth}
          xAxisColor={chartColors.separator}
          rulesColor={chartColors.separator}
          rulesType="solid"
          yAxisTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
          xAxisLabelTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
          isAnimated={false}
          disableScroll
        />
      ) : null}
    </View>
  );
});

type CategoryRow = { category: string; label: string; amount: string; fraction: number; color: string };

/**
 * The latest month split by cost category. A plain-View breakdown (coloured dot +
 * label + amount + a proportional bar) rather than a gifted chart — it reads as a
 * ranked list, needs no axis, and stays cheap to render. Memoized; its rows are
 * pre-computed by the screen.
 */
const CategoryBreakdown = memo(function CategoryBreakdown({ rows }: { rows: CategoryRow[] }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.categoryList}>
      {rows.map((row) => (
        <View key={row.category} style={styles.categoryRow}>
          <View style={styles.categoryHeader}>
            <View style={[styles.categoryDot, { backgroundColor: row.color }]} />
            <Text variant="subheadline" style={styles.categoryLabel} numberOfLines={1}>
              {row.label}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {row.amount}
            </Text>
          </View>
          <View style={[styles.categoryTrack, { backgroundColor: systemColors.fill }]}>
            <View
              style={[
                styles.categoryBar,
                { backgroundColor: row.color, width: `${Math.max(4, Math.round(row.fraction * 100))}%` },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
});

export default function CostsScreen() {
  const { t, i18n } = useTranslation('common');
  const { systemColors, brandColors, colorScheme, chartColors } = useTheme();
  const screenOptions = useStackScreenOptions();
  const bottomChrome = useBottomChromeMetrics();
  const runningCostsQuery = useRunningCosts(12);
  const report = runningCostsQuery.data;

  const currency = report?.currency ?? 'USD';
  const locale = i18n.language;
  const currencyFormatter = useMemo(
    () => getCachedNumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }),
    [locale, currency],
  );
  const formatDollars = useCallback((dollars: number) => currencyFormatter.format(dollars), [currencyFormatter]);

  const months = report?.months ?? [];
  const hasData = months.length > 0 && months.some((entry) => entry.totalCents > 0);

  const chartPoints = useMemo<CostPoint[]>(() => {
    if (months.length < 2) return [];
    const labels = buildMonthLabels(months, locale);
    return months.map((entry, index) => ({ value: entry.totalCents / 100, label: labels[index] }));
    // colorScheme is a data dep only through the memoized chart, but the labels
    // depend on the resolved locale + the month list identity.
  }, [months, locale]);

  const categoryRows = useMemo<CategoryRow[]>(() => {
    const latest = months[months.length - 1];
    if (!latest) return [];
    const positive = latest.byCategory.filter((entry) => entry.amountCents > 0);
    const maxAmount = positive.reduce((max, entry) => Math.max(max, entry.amountCents), 0);
    const categoryLabels: Record<string, string> = {
      hosting: t('mobile.costs.categoryHosting'),
      ai: t('mobile.costs.categoryAi'),
      domain: t('mobile.costs.categoryDomain'),
      other: t('mobile.costs.categoryOther'),
    };
    return [...positive]
      .sort((a, b) => b.amountCents - a.amountCents)
      .map((entry) => ({
        category: entry.category,
        label: categoryLabels[entry.category] ?? entry.category,
        amount: formatDollars(entry.amountCents / 100),
        fraction: maxAmount > 0 ? entry.amountCents / maxAmount : 0,
        color: categoryColor(entry.category, colorScheme, chartColors.secondaryLabel),
      }));
  }, [months, t, formatDollars, colorScheme, chartColors.secondaryLabel]);

  const handleChipIn = useCallback(() => {
    void openExternalUrl(SPONSORS_URL, 'costs-sponsor');
  }, []);

  const header = <Stack.Screen options={{ ...screenOptions, title: t('mobile.costs.title'), headerShown: true }} />;

  if (runningCostsQuery.isLoading) {
    return (
      <>
        {header}
        <View style={[styles.stateContainer, { backgroundColor: systemColors.groupedBackground }]}>
          <ActivityIndicator size="large" />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.costs.loading')}
          </Text>
        </View>
      </>
    );
  }

  if (runningCostsQuery.isError) {
    return (
      <>
        {header}
        <View style={[styles.stateContainer, { backgroundColor: systemColors.groupedBackground }]}>
          <Icon name="warning" size={40} color={systemColors.tertiaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
            {t('mobile.costs.error')}
          </Text>
          <Button
            title={t('mobile.costs.retry')}
            icon="refresh"
            variant="outlined"
            onPress={() => void runningCostsQuery.refetch()}
          />
        </View>
      </>
    );
  }

  if (!hasData) {
    return (
      <>
        {header}
        <View style={[styles.stateContainer, { backgroundColor: systemColors.groupedBackground }]}>
          <Icon name="chart.bar" size={40} color={systemColors.tertiaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
            {t('mobile.costs.empty')}
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      {header}
      <ScrollView
        style={{ backgroundColor: systemColors.groupedBackground }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.container, { paddingBottom: bottomChrome.scrollBottomPadding + spacing[6] }]}
      >
        <View style={[styles.hero, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.heroLabel}>
            {t('mobile.costs.perMonthLabel')}
          </Text>
          <Text variant="largeTitle" style={styles.heroAmount}>
            {formatDollars((report?.latestMonthlyTotalCents ?? 0) / 100)}
          </Text>
          <Text variant="body" color={systemColors.secondaryLabel} style={styles.heroBody}>
            {t('mobile.costs.headline')}
          </Text>
        </View>

        {chartPoints.length >= 2 ? (
          <View style={styles.section}>
            <SectionHeader title={t('mobile.costs.overTimeTitle')} />
            <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
              <CostOverTimeChart points={chartPoints} formatAxis={formatDollars} />
            </View>
          </View>
        ) : null}

        {categoryRows.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title={t('mobile.costs.byCategoryTitle')} />
            <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
              <CategoryBreakdown rows={categoryRows} />
            </View>
          </View>
        ) : null}

        <View style={[styles.notice, { backgroundColor: systemColors.secondaryBackground }]}>
          <View style={styles.noticeHeader}>
            <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
              <Icon name="favorite.fill" size={22} color={brandColors.primary} />
            </View>
            <Text variant="headline" style={styles.noticeHeaderTitle}>
              {t('mobile.costs.sponsorsTitle')}
            </Text>
          </View>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.noticeBody}>
            {t('mobile.costs.sponsorsBody')}
          </Text>
          <Button
            title={t('mobile.costs.sponsorsCta')}
            icon="favorite"
            size="large"
            variant="outlined"
            onPress={handleChipIn}
            style={styles.sponsorButton}
          />
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[6],
  },
  stateContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[6],
  },
  stateText: {
    textAlign: 'center',
    lineHeight: 20,
  },
  hero: {
    alignItems: 'center',
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[8],
  },
  heroLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  heroAmount: {
    marginTop: spacing[1],
    fontWeight: '800',
  },
  heroBody: {
    marginTop: spacing[3],
    textAlign: 'center',
    lineHeight: 22,
  },
  section: {
    gap: spacing[2],
  },
  card: {
    borderRadius: borderRadius.lg,
    padding: spacing[4],
  },
  categoryList: {
    gap: spacing[4],
  },
  categoryRow: {
    gap: spacing[2],
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  categoryDot: {
    width: 10,
    height: 10,
    borderRadius: borderRadius.full,
  },
  categoryLabel: {
    flex: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  categoryTrack: {
    height: 6,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  categoryBar: {
    height: 6,
    borderRadius: borderRadius.full,
  },
  notice: {
    borderRadius: borderRadius.lg,
    padding: spacing[4],
  },
  noticeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  noticeHeaderTitle: {
    flex: 1,
    fontWeight: '700',
  },
  noticeBody: {
    marginTop: spacing[2],
    lineHeight: 20,
  },
  cardIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
  },
  sponsorButton: {
    marginTop: spacing[4],
    alignSelf: 'flex-start',
  },
});
