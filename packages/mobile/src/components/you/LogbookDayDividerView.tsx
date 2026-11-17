import { describeLogbookDay, type LogbookDayStats } from '@boardsesh/logbook';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants';
import { BRAND_CHIP_WASH_ALPHA } from '../../theme/variants/variant-tokens';
import { Text } from '../Text';

// Off-grid on purpose: 8pt (spacing[2]) reads too tall around caption1 text in
// the compact chip, 4pt too tight against the wash edge.
const DIVIDER_VERTICAL_PADDING = 6;

export type LogbookDayDividerViewProps = {
  now: number;
  formatGrade: (grade: string | null | undefined) => string | null;
  /** Local start-of-day timestamp of the run (from buildLogbookListRows). */
  dayStartMs: number;
  /**
   * The day's wall ("Alex's board 35°") when the complete day is wall-uniform;
   * null on mixed days (which get LogbookWallSubDivider anchors instead) and
   * while the day may still straddle an unloaded page.
   */
  wallLabel?: string | null;
  /**
   * Rollup stats, or null while the day may still straddle an unloaded page —
   * a partial count would lie (including to VoiceOver), so an incomplete day
   * shows its date alone until its boundary loads.
   */
  stats: LogbookDayStats | null;
};

/**
 * Date anchor between logbook day runs — deliberately NOT a session card
 * (sessions live in the Sessions tab): just the day plus a counts rollup with
 * the hardest send. Liquid Glass draws the Velvet Send violet wash; Material
 * gets an M3-style list subheader (no chip). `accessibilityRole="header"` puts
 * each day in the VoiceOver/TalkBack rotor for day-jumping.
 */
export const LogbookDayDividerView = memo(function LogbookDayDividerView({
  now,
  formatGrade,
  dayStartMs,
  stats,
  wallLabel,
}: LogbookDayDividerViewProps) {
  const { t, i18n } = useTranslation('you');
  const { brandColors: brand, systemColors, variant } = useTheme();
  const { kind } = describeLogbookDay(dayStartMs, now);
  const label =
    kind === 'today'
      ? t('mobile.logbook.day.today')
      : kind === 'yesterday'
        ? t('mobile.logbook.day.yesterday')
        : new Date(dayStartMs).toLocaleDateString(i18n.language, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            ...(kind === 'older' ? { year: 'numeric' } : {}),
          });

  const topGradeLabel =
    stats?.topDifficultyName != null ? (formatGrade(stats.topDifficultyName) ?? stats.topDifficultyName) : null;
  const rollup = stats
    ? [
        t('mobile.logbook.day.climbs', { count: stats.climbCount }),
        stats.sendCount > 0 ? t('mobile.logbook.day.sends', { count: stats.sendCount }) : null,
        topGradeLabel ? t('mobile.logbook.day.top', { grade: topGradeLabel }) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const labelWithWall = wallLabel ? `${label} · ${wallLabel}` : label;

  // One combined announcement; `header` surfaces it in the screen-reader rotor.
  const accessibilityLabel = rollup ? `${labelWithWall}, ${rollup}` : labelWithWall;

  const chipStyle = selectByVariant(variant, {
    liquidGlass: {
      backgroundColor: withAlpha(brand.primaryFill, BRAND_CHIP_WASH_ALPHA.logbookDay),
      borderRadius: borderRadius.md,
    },
    material: null,
  });
  const labelColor = selectByVariant(variant, {
    // On the violet chip: the strong ink, which keeps 4.5:1 there (the tint does not).
    liquidGlass: brand.primaryStrong,
    material: systemColors.secondaryLabel,
  });

  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={accessibilityLabel}
      style={[styles.container, chipStyle]}
    >
      <View style={styles.dayRow}>
        <Text variant="subheadline" color={systemColors.label} style={styles.label}>
          {label}
        </Text>
        {rollup ? (
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.rollup}>
            {rollup}
          </Text>
        ) : null}
      </View>
      {wallLabel ? (
        <Text variant="caption1" color={labelColor}>
          {wallLabel}
        </Text>
      ) : null}
    </View>
  );
});

/**
 * Wall anchor inside a MIXED day — one per consecutive same-wall run, so the
 * rows below it can omit their repeated custom wall name. Board/layout and
 * angle always remain on each row. Quieter than
 * the day divider on purpose: plain caption, no wash, not a rotor header (the
 * day keeps rotor jumping clean).
 */
export const LogbookWallSubDivider = memo(function LogbookWallSubDivider({ wallLabel }: { wallLabel: string }) {
  const { systemColors } = useTheme();
  return (
    <View accessible accessibilityLabel={wallLabel} style={styles.subDivider}>
      <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.subDividerLabel}>
        {wallLabel}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    width: '100%',
    maxWidth: 672,
    alignSelf: 'center',
    gap: spacing[1],
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    marginBottom: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: DIVIDER_VERTICAL_PADDING,
  },
  dayRow: {
    flexDirection: 'row',
    // Wrap instead of colliding at accessibility type sizes — the rollup drops
    // below the day label when one line can't hold both.
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[2],
  },
  label: {
    fontWeight: '600',
  },
  rollup: {
    flexShrink: 1,
  },
  subDivider: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    marginBottom: spacing[1],
    paddingHorizontal: spacing[3],
  },
  subDividerLabel: {
    fontWeight: '600',
  },
});
