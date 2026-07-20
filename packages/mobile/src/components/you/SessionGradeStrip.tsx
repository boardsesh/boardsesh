import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { gradeAxisFloorSteps, vGradeNumber } from '@boardsesh/board-constants/boulder-grade-mapping';
import { Text } from '../Text';
import { buildSessionGradeBars, gradeChartColor, type ColoredBar } from './profile-chart-colors';
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

type FormatGrade = (difficulty: string | null | undefined) => string | null;

/**
 * Prepend empty grade bars so the spread starts at the boulder floor (V0)
 * rather than the lowest send. The floor bars carry a count of 0 (they render
 * short + faint) and stop just below the first real grade. Bars are returned
 * unchanged when the lowest send is already V0 or its grade carries no V token.
 */
function anchorGradeBarsAtFloor(bars: ColoredBar[], formatGrade: FormatGrade): ColoredBar[] {
  const firstKey = bars[0]?.key;
  const minV = firstKey != null ? vGradeNumber(firstKey) : null;
  if (minV == null) return bars;
  const floorSteps = gradeAxisFloorSteps(minV);
  if (floorSteps.length === 0) return bars;
  const floorBars: ColoredBar[] = floorSteps.map((grade) => {
    const label = formatGrade(grade.difficulty_name) ?? grade.v_grade;
    return { key: grade.v_grade, label, segments: [{ value: 0, key: grade.v_grade, label }] };
  });
  return [...floorBars, ...bars];
}

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

  // Anchor the axis at the boulder floor (V0), not the lowest send: a session of
  // V11–V17 sends reads "V0 → V17" with empty easy grades to the left, so the
  // spread advertises the board's whole range instead of only the hard end. The
  // 2+ guard runs on the real sends (below) — a single-grade session still isn't
  // a spread, floor padding notwithstanding.
  const anchoredBars = useMemo(() => (bars ? anchorGradeBarsAtFloor(bars, formatGrade) : null), [bars, formatGrade]);

  if (!bars || bars.length < 2 || !anchoredBars) return null;

  // Single pass: capture both the tallest count (drives heights + opacity) and
  // the most-climbed grade's label (the modal grade, announced to a11y). The
  // synthesized floor bars carry a count of 0, so they never win the modal.
  let maxCount = 0;
  let modalLabel = anchoredBars[0].label;
  for (const bar of anchoredBars) {
    const count = bar.segments[0]?.value ?? 0;
    if (count > maxCount) {
      maxCount = count;
      modalLabel = bar.label;
    }
  }
  const minLabel = anchoredBars[0].label;
  const maxLabel = anchoredBars[anchoredBars.length - 1].label;

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
        {anchoredBars.map((bar) => {
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
