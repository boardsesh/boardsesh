import { Fragment, useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import Svg, { Rect } from 'react-native-svg';
import type { RawActivityDay, RawActivityHeatmap, RawStreaks } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { buildIntensityFills, colorForCount, INTENSITY_STEPS } from './heatmap-intensity';

const ROWS = 7;
const CELL_GAP = 3;
// Column budget (cell + gap) used to decide how many weeks fit the screen.
const TARGET_COLUMN = 16;

type ActivityHeatmapProps = {
  heatmap: RawActivityHeatmap;
  /** Weekly streak — when set, the card gains a flame "{n}-week streak" header. */
  streak?: RawStreaks;
};

/**
 * GitHub-style climbing calendar: one cell per day, intensity ∝ ascents that
 * day. The shared builder hands us a whole week-aligned window (≈53 weeks); a
 * phone can't show that many legible columns, so we fit the most recent weeks
 * edge-to-edge — the recent calendar is the part people read. Single instance on
 * a scroll screen, so the SVG grid isn't subject to the list-virtualization rule.
 */
export function ActivityHeatmap({ heatmap, streak }: ActivityHeatmapProps) {
  const { colorScheme, chartColors, brandColors } = useTheme();
  const { t } = useTranslation('profile');
  const [width, setWidth] = useState(0);

  const columns = useMemo(() => {
    const result: RawActivityDay[][] = [];
    for (let index = 0; index < heatmap.days.length; index += ROWS) {
      result.push(heatmap.days.slice(index, index + ROWS));
    }
    return result;
  }, [heatmap.days]);

  const totals = useMemo(() => {
    let totalClimbs = 0;
    let activeDays = 0;
    for (const day of heatmap.days) {
      totalClimbs += day.count;
      if (day.count > 0) activeDays += 1;
    }
    return { totalClimbs, activeDays };
  }, [heatmap.days]);

  // Per-variant brand accent (opaque hex on every variant/scheme) composited onto
  // the opaque card surface so the ramp + empty floor stay legible regardless of
  // what sits behind the SVG. Computed once per scheme/variant change via the
  // shared ramp helper (also drives the wall-rhythm grid, so they stay siblings).
  const primary = chartColors.accent;
  const surface = chartColors.secondaryBackground;
  const fills = useMemo(() => buildIntensityFills(primary, surface, colorScheme), [primary, surface, colorScheme]);
  const { emptyFill, stepFills } = fills;

  // "Today" via a LOCAL date string (NOT toISOString, which is UTC) so the
  // current-day ring lands on the right cell across time zones.
  const todayKey = useMemo(() => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${dayOfMonth}`;
  }, []);

  const fillForCount = useCallback(
    (count: number): string => colorForCount(count, heatmap.maxCount, fills),
    [fills, heatmap.maxCount],
  );

  const fitWeeks =
    width > 0 ? Math.min(columns.length, Math.max(1, Math.floor((width + CELL_GAP) / TARGET_COLUMN))) : 0;
  const shown = fitWeeks > 0 ? columns.slice(-fitWeeks) : [];
  const cell = shown.length > 0 ? (width - CELL_GAP * (shown.length - 1)) / shown.length : 0;
  const gridHeight = ROWS * cell + (ROWS - 1) * CELL_GAP;
  // Corner radius scales with cell size but is capped by the sm token so wide
  // cells don't over-round into pills.
  const cornerRadius = Math.min(borderRadius.sm, Math.round(cell * 0.22));
  // Current-day ring: inset by half its stroke so it sits inside the cell.
  const ringWidth = Math.max(1.5, cell * 0.12);

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  // Live streak header: flame + "{n}-week streak" left, "best {n} wks" right.
  // Only when a streak is actually running — a "0-week streak" header is noise.
  const showStreakHeader = streak != null && streak.currentWeeks > 0;

  return (
    <View
      onLayout={onLayout}
      accessibilityRole="image"
      accessibilityLabel={t('stats.calendarAria', { days: totals.activeDays, count: totals.totalClimbs })}
    >
      {showStreakHeader ? (
        <View style={styles.streakHeader} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={styles.streakLeft}>
            <Icon name="flame" size={16} color={brandColors.accent} />
            <Text variant="headline" color={chartColors.label}>
              {t('dashboard.streakChip', { count: streak.currentWeeks })}
            </Text>
          </View>
          {streak.longestWeeks > 0 ? (
            <Text variant="footnote" color={chartColors.secondaryLabel}>
              {t('dashboard.streakBestWeeks', { count: streak.longestWeeks })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {width > 0 && cell > 0 ? (
        <Svg width={width} height={gridHeight}>
          {shown.map((column, columnIndex) =>
            column.map((day, rowIndex) => {
              const cellX = columnIndex * (cell + CELL_GAP);
              const cellY = rowIndex * (cell + CELL_GAP);
              // Single pass: the base cell plus, only for today, an inset ring
              // sibling — no second traversal of the ~371-cell grid.
              return (
                <Fragment key={day.date}>
                  <Rect
                    x={cellX}
                    y={cellY}
                    width={cell}
                    height={cell}
                    rx={cornerRadius}
                    ry={cornerRadius}
                    fill={fillForCount(day.count)}
                    stroke={chartColors.separator}
                    strokeWidth={StyleSheet.hairlineWidth}
                  />
                  {day.date === todayKey ? (
                    <Rect
                      x={cellX + ringWidth / 2}
                      y={cellY + ringWidth / 2}
                      width={cell - ringWidth}
                      height={cell - ringWidth}
                      rx={cornerRadius}
                      ry={cornerRadius}
                      fill="none"
                      stroke={brandColors.accent}
                      strokeWidth={ringWidth}
                    />
                  ) : null}
                </Fragment>
              );
            }),
          )}
        </Svg>
      ) : null}

      <View style={styles.legend}>
        <Text variant="caption2" color={chartColors.tertiaryLabel}>
          {t('stats.calendarLess')}
        </Text>
        <View style={[styles.legendSwatches, { gap: CELL_GAP }]}>
          <View
            style={[
              styles.swatch,
              styles.emptySwatch,
              { backgroundColor: emptyFill, borderColor: chartColors.separator },
            ]}
          />
          {stepFills.map((fill, stepIndex) => (
            <View key={INTENSITY_STEPS[stepIndex]} style={[styles.swatch, { backgroundColor: fill }]} />
          ))}
        </View>
        <Text variant="caption2" color={chartColors.tertiaryLabel}>
          {t('stats.calendarMore')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  streakHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing[3],
  },
  streakLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing[2],
    marginTop: spacing[3],
  },
  legendSwatches: {
    flexDirection: 'row',
  },
  swatch: {
    width: spacing[3],
    height: spacing[3],
    borderRadius: borderRadius.sm,
  },
  emptySwatch: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
