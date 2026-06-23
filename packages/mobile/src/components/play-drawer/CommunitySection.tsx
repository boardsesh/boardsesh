import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { SegmentedControl } from '../SegmentedControl';
import { DifficultyByAngleChart } from './DifficultyByAngleChart';
import { buildAngleGradeBars, totalSendsForSource } from './community-utils';
import { useClimbStatsForAngles } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useAscentCountSource } from '../../lib/ascent-count-source-preference';
import { boardAppCount, selectSourceCount, type AscentCountSource } from '../../lib/ascent-count-source';
import { useTheme } from '../../providers/theme-provider';
import { formatQuality } from '../../lib/format-climb-stats';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type CommunitySectionProps = {
  climbUuid: string;
  boardName: string;
  qualityAverage: string;
  ascensionistCount: number;
  // Per-source ascensionist counts for the headline + breakdown (all nullable).
  kilterAscensionistCount?: number | null;
  auroraAscensionistCount?: number | null;
  boardseshAscensionistCount?: number | null;
};

export const CommunitySection = memo(function CommunitySection({
  climbUuid,
  boardName,
  qualityAverage,
  ascensionistCount,
  kilterAscensionistCount,
  auroraAscensionistCount,
  boardseshAscensionistCount,
}: CommunitySectionProps) {
  const { t } = useTranslation('session');
  const { gradeFormat } = useGradeFormat();
  const { systemColors } = useTheme();
  const { source: preferredSource, loaded: preferenceLoaded } = useAscentCountSource();
  const { data: angleStats } = useClimbStatsForAngles(boardName, climbUuid);

  // Chart source is a LOCAL, per-view override — toggling it never writes back to
  // the global "Ascent counts" setting. Seeded from the user's preference.
  const [chartSource, setChartSource] = useState<AscentCountSource>(preferredSource);

  // `preferredSource` starts at the "all" default before the AsyncStorage read
  // resolves, so the initial useState seed can miss a saved "boardApp"/
  // "boardsesh" choice. Re-seed once the preference loads — but stop as soon as
  // the user picks a source here, so we never clobber their local override.
  const userPickedChartSource = useRef(false);
  useEffect(() => {
    if (preferenceLoaded && !userPickedChartSource.current) {
      setChartSource(preferredSource);
    }
  }, [preferenceLoaded, preferredSource]);

  const handleSelectChartSource = useCallback((next: AscentCountSource) => {
    userPickedChartSource.current = true;
    setChartSource(next);
  }, []);

  const qualityNum = parseFloat(qualityAverage);
  const hasQuality = qualityNum > 0;

  // Memoize the five quality stars so a chartSource toggle (local state) doesn't
  // rebuild this array every render.
  const starIcons = useMemo(() => {
    if (!hasQuality) return null;
    const fullStars = Math.floor(qualityNum);
    return Array.from({ length: 5 }, (_, starIndex) => (
      <Icon
        key={starIndex}
        name={starIndex < fullStars ? 'star.fill' : 'star'}
        size={14}
        color={starIndex < fullStars ? iosSystemColors.starGold : iosSystemColors.systemGray4}
      />
    ));
  }, [qualityNum, hasQuality]);

  // The four count fields the selector reads (climb-level totals from props).
  const countFields = useMemo(
    () => ({
      total: ascensionistCount,
      kilter: kilterAscensionistCount,
      aurora: auroraAscensionistCount,
      boardsesh: boardseshAscensionistCount,
    }),
    [ascensionistCount, kilterAscensionistCount, auroraAscensionistCount, boardseshAscensionistCount],
  );

  // Headline reflects the user's chosen source. "Board app" keeps a display-only
  // fallback to the combined total when this climb carries no board-app split
  // (kilter + aurora both absent/null — e.g. a Boardsesh-origin climb) so the
  // headline isn't blank. The breakdown + toggle below stay strict (they treat a
  // null source as a real 0), so they never show a phantom "Board app" entry.
  // "Boardsesh" is exact too: a null there means no Boardsesh senders → 0.
  const headlineCount =
    preferredSource === 'boardApp' && kilterAscensionistCount == null && auroraAscensionistCount == null
      ? ascensionistCount
      : selectSourceCount(countFields, preferredSource);
  const hasAscensionists = headlineCount > 0;

  // Per-source breakdown: only the non-zero meaningful sources (Board app =
  // max(kilter, aurora), and Boardsesh). Suppressed when fewer than two are
  // present — a single source is redundant with the headline total.
  const breakdownEntries = useMemo(() => {
    const present: { source: AscentCountSource; count: number }[] = [];
    // Only treat Board app as a real source when the climb actually carries a
    // board-app split — otherwise `boardAppCount` would fall back to the total
    // for absent (undefined) fields and show a phantom "Board app" entry. Same
    // guard the headline uses.
    const hasBoardAppData = countFields.kilter != null || countFields.aurora != null;
    const boardApp = boardAppCount(countFields);
    if (hasBoardAppData && boardApp > 0) present.push({ source: 'boardApp', count: boardApp });
    const boardsesh = countFields.boardsesh ?? 0;
    if (boardsesh > 0) present.push({ source: 'boardsesh', count: boardsesh });
    return present;
  }, [countFields]);

  const sourceLabel = useMemo(
    (): Record<AscentCountSource, string> => ({
      all: t('mobile.community.source.all'),
      boardApp: t('mobile.community.source.boardApp'),
      boardsesh: t('mobile.community.source.boardsesh'),
    }),
    [t],
  );

  const breakdownText = useMemo(() => {
    if (breakdownEntries.length < 2) return null;
    return breakdownEntries
      .map((entry) =>
        t('mobile.community.breakdownEntry', {
          source: sourceLabel[entry.source],
          value: entry.count.toLocaleString(),
        }),
      )
      .join(' · ');
  }, [breakdownEntries, sourceLabel, t]);

  // Totals across all angles per source — drive which toggle keys are disabled
  // (a source with 0 across every angle) and whether the toggle shows at all.
  const sourceTotals = useMemo(
    () => ({
      all: totalSendsForSource(angleStats, 'all'),
      boardApp: totalSendsForSource(angleStats, 'boardApp'),
      boardsesh: totalSendsForSource(angleStats, 'boardsesh'),
    }),
    [angleStats],
  );

  const disabledSourceKeys = useMemo(() => {
    const disabled = new Set<AscentCountSource>();
    if (sourceTotals.boardApp === 0) disabled.add('boardApp');
    if (sourceTotals.boardsesh === 0) disabled.add('boardsesh');
    return disabled;
  }, [sourceTotals]);

  // Show the toggle only when more than one source has data — otherwise All /
  // Board app / Boardsesh would all be identical (or only one is non-zero), so
  // the toggle adds nothing (e.g. non-Kilter boards, or no Boardsesh ticks).
  const nonZeroSourceCount = [sourceTotals.boardApp, sourceTotals.boardsesh].filter((count) => count > 0).length;
  const showSourceToggle = nonZeroSourceCount > 1;

  // The active chart source: when its key is disabled (no data) fall back to All
  // so the chart never renders an all-zero series from a stale selection.
  const activeChartSource: AscentCountSource =
    chartSource !== 'all' && disabledSourceKeys.has(chartSource) ? 'all' : chartSource;

  const angleBars = useMemo(
    () => buildAngleGradeBars(angleStats, gradeFormat, activeChartSource),
    [angleStats, gradeFormat, activeChartSource],
  );

  const sourceOptions: { key: AscentCountSource; label: string }[] = useMemo(
    () => [
      { key: 'all', label: sourceLabel.all },
      { key: 'boardApp', label: sourceLabel.boardApp },
      { key: 'boardsesh', label: sourceLabel.boardsesh },
    ],
    [sourceLabel],
  );

  // Only qualify the caption with the source when the toggle is shown; a
  // single-source chart has no source to disambiguate.
  const chartCaption = showSourceToggle
    ? t('mobile.community.ascentsByAngleSource', { source: sourceLabel[activeChartSource] })
    : t('mobile.community.ascentsByAngle');

  if (!hasQuality && !hasAscensionists && angleBars.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Icon name="people" size={20} color={iosSystemColors.systemGray} />
        <Text variant="subheadline" color={iosSystemColors.systemGray}>
          {t('mobile.community.empty')}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {hasQuality && (
        <View style={styles.statRow}>
          <View style={styles.starsRow}>{starIcons}</View>
          <Text variant="subheadline" color={iosSystemColors.systemGray}>
            {formatQuality(qualityAverage)} &middot; {t('mobile.community.avgQuality')}
          </Text>
        </View>
      )}

      {hasAscensionists && (
        <View style={styles.ascensionistBlock}>
          <View style={styles.statRow}>
            <Icon name="people" size={18} color={iosSystemColors.systemGray} />
            <Text variant="subheadline">{t('mobile.community.ascensionists', { count: headlineCount })}</Text>
          </View>
          {breakdownText ? (
            <Text
              variant="footnote"
              color={systemColors.secondaryLabel}
              style={styles.breakdown}
              accessibilityLabel={t('mobile.community.breakdownAccessibility', { breakdown: breakdownText })}
            >
              {breakdownText}
            </Text>
          ) : null}
        </View>
      )}

      {angleBars.length > 0 && (
        <View style={styles.histogram}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {chartCaption}
          </Text>
          {showSourceToggle ? (
            <SegmentedControl
              options={sourceOptions}
              selectedKey={activeChartSource}
              onSelect={handleSelectChartSource}
              disabledKeys={disabledSourceKeys}
              textVariant="footnote"
              trackColor={systemColors.fill}
              accessibilityLabel={t('mobile.community.ascentSource')}
            />
          ) : null}
          <DifficultyByAngleChart
            data={angleBars}
            yAxisTitle={t('mobile.community.sendsAxis')}
            emptyMessage={t('mobile.community.noAscentsForSource')}
            accessibilityLabel={chartCaption}
            logScaleLabel={t('mobile.community.logScale')}
          />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
  },
  emptyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  ascensionistBlock: {
    gap: 2,
  },
  breakdown: {
    marginLeft: spacing[2] + 18,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 2,
  },
  histogram: {
    gap: spacing[2],
  },
});
