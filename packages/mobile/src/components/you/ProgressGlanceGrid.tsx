import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RawStreaks, RawProjectingStats, RawBenchmarkSummary, RawActiveDaysDelta } from '@boardsesh/profile-stats';
import { GlanceTile, type GlanceDelta } from './GlanceTile';
import { resolveBiggestFightTile, deltaKind } from './glance-grid-model';
import { gradeBadgeColor } from './profile-chart-colors';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type ProgressGlanceGridProps = {
  streaks: RawStreaks;
  projectingStats: RawProjectingStats;
  benchmarkSummary: RawBenchmarkSummary;
  activeDaysDelta: RawActiveDaysDelta;
  totalAscents: number;
};

/**
 * The 2×2 trophy grid under the hero: streak · biggest fight · benchmarks · this
 * month. Each tile is a calm tonal surface with the grade/brand hue only on the
 * glyph; the numbers count up on mount. Built to be screenshotted.
 */
export function ProgressGlanceGrid({
  streaks,
  projectingStats,
  benchmarkSummary,
  activeDaysDelta,
  totalAscents,
}: ProgressGlanceGridProps) {
  const { t } = useTranslation('profile');
  const { brandColors } = useTheme();

  const fight = resolveBiggestFightTile(projectingStats, totalAscents);
  const delta = activeDaysDelta.delta;
  const kind = deltaKind(delta);
  const deltaChip: GlanceDelta = {
    kind,
    label:
      kind === 'up'
        ? t('dashboard.deltaUp', { count: delta })
        : kind === 'down'
          ? t('dashboard.deltaDown', { count: Math.abs(delta) })
          : t('dashboard.deltaSame'),
  };

  return (
    <View style={styles.grid}>
      <View style={styles.row}>
        <GlanceTile
          glyph="flame"
          glyphColor={brandColors.accent}
          value={streaks.currentWeeks}
          label={t('dashboard.weekStreak')}
          sublabel={streaks.longestWeeks > 0 ? t('dashboard.streakBest', { count: streaks.longestWeeks }) : undefined}
          accessibilityLabel={t('dashboard.streakA11y', {
            count: streaks.currentWeeks,
            best: streaks.longestWeeks,
          })}
        />
        {fight.kind === 'fight' ? (
          <GlanceTile
            glyph="crown"
            glyphColor={gradeBadgeColor(fight.grade)}
            value={fight.tries}
            valueColor={gradeBadgeColor(fight.grade)}
            label={t('dashboard.triesUnitLabel', { count: fight.tries })}
            sublabel={fight.grade ? t('dashboard.biggestFightGrade', { grade: fight.grade }) : undefined}
            accessibilityLabel={t('dashboard.biggestFightA11y', { count: fight.tries, grade: fight.grade })}
          />
        ) : (
          <GlanceTile
            glyph="checkmark.circle.fill"
            glyphColor={brandColors.primary}
            value={fight.total}
            label={t('dashboard.sendsUnitLabel', { count: fight.total })}
            accessibilityLabel={t('dashboard.sends', { count: fight.total })}
          />
        )}
      </View>
      <View style={styles.row}>
        <GlanceTile
          glyph="benchmark"
          glyphColor={brandColors.accent}
          value={benchmarkSummary.count}
          label={t('dashboard.benchmarks')}
          sublabel={
            benchmarkSummary.hardestLabel
              ? t('dashboard.benchmarksHardest', { grade: benchmarkSummary.hardestLabel })
              : undefined
          }
          accessibilityLabel={t('dashboard.benchmarksA11y', {
            count: benchmarkSummary.count,
            grade: benchmarkSummary.hardestLabel ?? '',
          })}
        />
        <GlanceTile
          glyph="calendar"
          glyphColor={brandColors.primary}
          value={activeDaysDelta.thisMonth}
          label={t('dashboard.daysThisMonthLabel', { count: activeDaysDelta.thisMonth })}
          delta={deltaChip}
          sparkline={activeDaysDelta.sparkline}
          accessibilityLabel={t('dashboard.activeDaysA11y', {
            count: activeDaysDelta.thisMonth,
            delta: deltaChip.label,
          })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    marginHorizontal: spacing[4],
    gap: spacing[3],
  },
  row: {
    flexDirection: 'row',
    gap: spacing[2],
  },
});
