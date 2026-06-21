import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { buildSessionGradeBars, gradeChartColor } from './profile-chart-colors';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, opacity } from '../../theme/tokens';

const BAR_MAX_HEIGHT = 20;
const BAR_MIN_HEIGHT = 8;
// Floor for the count-driven fill opacity so the rarest grades stay visible.
const BAR_MIN_OPACITY = opacity.peek;

type SessionGradeStripProps = {
  distribution: SessionGradeDistributionItem[];
  totalSends: number;
};

/**
 * Compact "grade pyramid" for a feed card: one vivid grade-coloured bar per
 * occupied grade, ordered easy→hard, bar height ∝ ascent count. It's the
 * session's grade SPREAD — the breadth signal the hero (a single climb) can't
 * show, and the thing that makes a card read as "a session". Pure Views (no
 * chart lib), always-on, non-interactive; it sits in the header→hero gap and
 * doubles as the separator. Hidden unless there are 2+ grades (a single grade
 * isn't a spread), and self-hides on an empty distribution.
 */
export const SessionGradeStrip = memo(function SessionGradeStrip({ distribution, totalSends }: SessionGradeStripProps) {
  const { systemColors, colorScheme } = useTheme();
  const { t } = useTranslation('feed');
  const { formatGrade } = useGradeFormat();

  // Reuse the chart builder: easy→hard order, empty grades dropped, each grade's
  // vivid colour + total already resolved. Solid bars (no splitFlash).
  const bars = useMemo(() => buildSessionGradeBars(distribution, formatGrade), [distribution, formatGrade]);

  if (!bars || bars.length < 2) return null;

  // Single pass: capture both the tallest count (drives heights + opacity) and
  // the most-climbed grade's label (the modal grade, announced to a11y).
  let maxCount = 0;
  let modalLabel = bars[0].label;
  for (const bar of bars) {
    const count = bar.segments[0]?.value ?? 0;
    if (count > maxCount) {
      maxCount = count;
      modalLabel = bar.label;
    }
  }
  const minLabel = bars[0].label;
  const maxLabel = bars[bars.length - 1].label;

  return (
    <View
      style={styles.container}
      pointerEvents="none"
      accessibilityRole="image"
      accessibilityLabel={t('sessionFeedCard.gradeSpread', { min: minLabel, max: maxLabel, sends: totalSends })}
      // Name the most-climbed (modal) grade as the strip's value. The label is a
      // grade token (e.g. "V6"), not a translatable string — no i18n key needed.
      accessibilityValue={{ text: modalLabel }}
    >
      <View style={styles.bars}>
        {bars.map((bar) => {
          const value = bar.segments[0]?.value ?? 0;
          // Scheme-aware fill: keep the segment's explicit grade colour when set,
          // otherwise derive a contrast-clamped fill for the current scheme so
          // the strip keeps contrast on dark cards.
          const color = bar.segments[0]?.color ?? gradeChartColor(bar.key, colorScheme);
          const ratio = maxCount > 0 ? value / maxCount : 1;
          const height = maxCount > 0 ? Math.max(BAR_MIN_HEIGHT, Math.round(ratio * BAR_MAX_HEIGHT)) : BAR_MIN_HEIGHT;
          // Modulate fill opacity by relative count: the tallest grade reads full,
          // rarer grades fade toward BAR_MIN_OPACITY (reuses maxCount, no new scan).
          const fillOpacity = BAR_MIN_OPACITY + (1 - BAR_MIN_OPACITY) * ratio;
          return <View key={bar.key} style={[styles.bar, { height, backgroundColor: color, opacity: fillOpacity }]} />;
        })}
      </View>
      <View style={styles.labels}>
        <Text variant="caption2" color={systemColors.secondaryLabel}>
          {minLabel}
        </Text>
        <Text variant="caption2" color={systemColors.secondaryLabel}>
          {maxLabel}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { marginTop: spacing[2], gap: spacing[1] },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: BAR_MAX_HEIGHT },
  // Round only the top caps so the bars sit flush on the baseline.
  bar: { flex: 1, borderTopLeftRadius: borderRadius.sm, borderTopRightRadius: borderRadius.sm },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
});
