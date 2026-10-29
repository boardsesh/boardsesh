import { Fragment, memo, useCallback, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import Svg, { Rect } from 'react-native-svg';
import type { RawActivityDay, RawActivityHeatmap } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useScreenReaderEnabled } from '../../hooks/use-screen-reader-enabled';
import { borderRadius, spacing } from '../../theme/tokens';
import { nowDate } from '../../lib/clock';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useShowcaseAnchor } from '../../lib/showcase-anchor';
import {
  CALENDAR_ROWS,
  LABELLED_WEEKDAY_ROWS,
  buildCalendarRamp,
  chunkIntoWeeks,
  localDateFromDayKey,
  localDayKey,
  monthLabelColumns,
  stepIndexForCount,
} from './activity-heatmap-model';

const CELL_GAP = 3;
// Column budget (cell + gap) used to decide how many weeks fit the screen.
const TARGET_COLUMN = 16;
// Left gutter for the Mon / Wed / Fri labels ("lun." is the widest we ship).
const WEEKDAY_GUTTER = 28;
const WEEKDAY_GUTTER_GAP = spacing[1];
const TODAY_SWATCH_BORDER = 1.5;

// Hoisted so every label shares one formatter cache key (#3155).
const MONTH_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short' };
const WEEKDAY_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'short' };
const DAY_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
const WEEK_START_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

type ActivityHeatmapProps = {
  heatmap: RawActivityHeatmap;
};

/**
 * GitHub-style climbing calendar: one cell per day, intensity ∝ ascents that
 * day. The shared builder hands us a whole week-aligned window (≈53 weeks); a
 * phone can't show that many legible columns, so we fit the most recent weeks
 * edge-to-edge — the recent calendar is the part people read. Month labels run
 * along the top and Mon / Wed / Fri down the side; tapping a day prints its
 * count under the grid, and each week column is one screen-reader element that
 * reads out the days climbed in it. Single instance on a scroll screen, so the
 * SVG grid isn't subject to the list-virtualization rule.
 */
export function ActivityHeatmap({ heatmap }: ActivityHeatmapProps) {
  const { colorScheme, chartColors, brandColors } = useTheme();
  const { t, i18n } = useTranslation('profile');
  const locale = i18n.language;
  const [width, setWidth] = useState(0);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  const weeks = useMemo(() => chunkIntoWeeks(heatmap.days), [heatmap.days]);

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
  // what sits behind the SVG. Computed once per scheme/variant change.
  const primary = chartColors.accent;
  const surface = chartColors.secondaryBackground;
  const { emptyFill, stepFills } = useMemo(
    () => buildCalendarRamp(primary, surface, colorScheme),
    [primary, surface, colorScheme],
  );

  // "Today" via a LOCAL date string (NOT toISOString, which is UTC) so the
  // current-day ring lands on the right cell across time zones. Read every
  // render, not memoised at mount: it also gates taps on future days, and the
  // Progress tab can stay mounted past midnight.
  const todayKey = localDayKey(nowDate());

  const colorForCount = useCallback(
    (count: number): string => {
      const stepIndex = stepIndexForCount(count, heatmap.maxCount);
      return stepIndex < 0 ? emptyFill : stepFills[stepIndex];
    },
    [emptyFill, stepFills, heatmap.maxCount],
  );

  const gridWidth = Math.max(0, width - WEEKDAY_GUTTER - WEEKDAY_GUTTER_GAP);
  const fitWeeks =
    gridWidth > 0 ? Math.min(weeks.length, Math.max(1, Math.floor((gridWidth + CELL_GAP) / TARGET_COLUMN))) : 0;
  const shown = useMemo(() => (fitWeeks > 0 ? weeks.slice(-fitWeeks) : []), [weeks, fitWeeks]);
  const cell = shown.length > 0 ? (gridWidth - CELL_GAP * (shown.length - 1)) / shown.length : 0;
  const pitch = cell + CELL_GAP;
  const gridHeight = CALENDAR_ROWS * cell + (CALENDAR_ROWS - 1) * CELL_GAP;
  // Corner radius scales with cell size but is capped by the sm token so wide
  // cells don't over-round into pills.
  const cornerRadius = Math.min(borderRadius.sm, Math.round(cell * 0.22));
  // Current-day ring: inset by half its stroke so it sits inside the cell.
  const ringWidth = Math.max(1.5, cell * 0.12);

  const monthLabels = useMemo(() => {
    const formatter = getCachedDateTimeFormat(locale, MONTH_OPTIONS);
    return monthLabelColumns(shown).map((columnIndex) => ({
      columnIndex,
      dayKey: shown[columnIndex][0].date,
      label: formatter.format(localDateFromDayKey(shown[columnIndex][0].date)),
    }));
  }, [shown, locale]);

  const weekdayLabels = useMemo(() => {
    const monday = weeks[0]?.[0]?.date;
    if (!monday) return [];
    const formatter = getCachedDateTimeFormat(locale, WEEKDAY_OPTIONS);
    // Any week works: the grid is ISO-week aligned, so row 0 is always Monday.
    const mondayDate = localDateFromDayKey(monday);
    return LABELLED_WEEKDAY_ROWS.map((rowIndex) => {
      const date = new Date(mondayDate);
      date.setDate(mondayDate.getDate() + rowIndex);
      return { rowIndex, label: formatter.format(date) };
    });
  }, [weeks, locale]);

  const describeCount = useCallback(
    (count: number) => (count > 0 ? t('stats.calendarClimbs', { count }) : t('stats.calendarNoClimbs')),
    [t],
  );

  const weekAccessibilityLabels = useMemo(() => {
    const dayFormatter = getCachedDateTimeFormat(locale, DAY_OPTIONS);
    const weekFormatter = getCachedDateTimeFormat(locale, WEEK_START_OPTIONS);
    return shown.map((week) => {
      const date = weekFormatter.format(localDateFromDayKey(week[0].date));
      const activeDays = week.filter((day) => day.count > 0);
      if (activeDays.length === 0) return t('stats.calendarWeekEmptyAria', { date });
      const days = activeDays
        .map((day) => `${dayFormatter.format(localDateFromDayKey(day.date))}, ${describeCount(day.count)}`)
        .join('; ');
      return t('stats.calendarWeekAria', { date, days });
    });
  }, [shown, locale, t, describeCount]);

  // Only a visible cell can stay selected: a narrower layout or a refetch that
  // slides the window drops the readout rather than describing a hidden day.
  const selectedDay = useMemo<RawActivityDay | null>(() => {
    if (!selectedDayKey) return null;
    for (const week of shown) {
      const match = week.find((day) => day.date === selectedDayKey);
      if (match) return match;
    }
    return null;
  }, [shown, selectedDayKey]);

  // A screen reader's double-tap lands on the column's centre, which would pick
  // Thursday whatever the climber meant; the week label already reads out
  // every day, so the columns are read-only while one is running.
  const screenReaderEnabled = useScreenReaderEnabled();

  const handleWeekPress = useCallback(
    (columnIndex: number, event: GestureResponderEvent) => {
      const week = shown[columnIndex];
      if (!week || pitch <= 0) return;
      // Each row owns its cell plus half the gap on either side.
      const rowIndex = Math.min(
        CALENDAR_ROWS - 1,
        Math.max(0, Math.floor((event.nativeEvent.locationY + CELL_GAP / 2) / pitch)),
      );
      const day = week[rowIndex];
      // Days later this week haven't happened yet; there's nothing to report.
      if (!day || day.date > todayKey) return;
      setSelectedDayKey((current) => (current === day.date ? null : day.date));
    },
    [shown, pitch, todayKey],
  );

  const calendarAnchor = useShowcaseAnchor('activity-calendar');
  const onLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
    calendarAnchor.onLayout?.(event);
  };

  const detailText = selectedDay
    ? `${getCachedDateTimeFormat(locale, DAY_OPTIONS).format(localDateFromDayKey(selectedDay.date))} · ${describeCount(selectedDay.count)}`
    : t('stats.calendarTapHint');

  return (
    <View ref={calendarAnchor.ref} onLayout={onLayout}>
      {width > 0 && cell > 0 ? (
        <>
          <View
            accessible
            accessibilityLabel={t('stats.calendarAria', { days: totals.activeDays, count: totals.totalClimbs })}
            style={styles.monthRow}
          >
            {/* Invisible line of caption2 so the row grows with the text size;
                the real labels are absolutely placed over their columns. */}
            <Text variant="caption2" style={styles.monthRowSizer}>
              {' '}
            </Text>
            {monthLabels.map(({ columnIndex, dayKey, label }) => (
              <Text
                key={dayKey}
                variant="caption2"
                color={chartColors.secondaryLabel}
                numberOfLines={1}
                style={[styles.monthLabel, { left: columnIndex * pitch }]}
              >
                {label}
              </Text>
            ))}
          </View>

          <View style={styles.gridRow}>
            <View
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={[styles.weekdayGutter, { height: gridHeight }]}
            >
              {weekdayLabels.map(({ rowIndex, label }) => (
                <View key={rowIndex} style={[styles.weekdayLabel, { top: rowIndex * pitch, height: cell }]}>
                  <Text variant="caption2" color={chartColors.secondaryLabel} numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              ))}
            </View>

            <View style={{ width: gridWidth, height: gridHeight }}>
              <Svg width={gridWidth} height={gridHeight}>
                {shown.map((week, columnIndex) =>
                  week.map((day, rowIndex) => {
                    const cellX = columnIndex * pitch;
                    const cellY = rowIndex * pitch;
                    const ringColor =
                      day.date === selectedDayKey
                        ? chartColors.label
                        : day.date === todayKey
                          ? brandColors.accent
                          : null;
                    // Single pass: the base cell plus, only for today or the
                    // tapped day, an inset ring sibling — no second traversal.
                    return (
                      <Fragment key={day.date}>
                        <Rect
                          x={cellX}
                          y={cellY}
                          width={cell}
                          height={cell}
                          rx={cornerRadius}
                          ry={cornerRadius}
                          fill={colorForCount(day.count)}
                          stroke={chartColors.separator}
                          strokeWidth={StyleSheet.hairlineWidth}
                        />
                        {ringColor ? (
                          <Rect
                            x={cellX + ringWidth / 2}
                            y={cellY + ringWidth / 2}
                            width={cell - ringWidth}
                            height={cell - ringWidth}
                            rx={cornerRadius}
                            ry={cornerRadius}
                            fill="none"
                            stroke={ringColor}
                            strokeWidth={ringWidth}
                          />
                        ) : null}
                      </Fragment>
                    );
                  }),
                )}
              </Svg>
              {/* One hit area per week column: taps pick the row from
                  locationY, screen readers read the whole week. */}
              {shown.map((week, columnIndex) => (
                <WeekHitArea
                  key={week[0].date}
                  columnIndex={columnIndex}
                  left={columnIndex * pitch}
                  width={columnIndex === shown.length - 1 ? cell : pitch}
                  accessibilityLabel={weekAccessibilityLabels[columnIndex]}
                  readOnly={screenReaderEnabled}
                  onPress={handleWeekPress}
                />
              ))}
            </View>
          </View>

          <Text
            variant="caption1"
            color={selectedDay ? chartColors.label : chartColors.secondaryLabel}
            accessibilityLiveRegion="polite"
            style={styles.detail}
          >
            {detailText}
          </Text>
        </>
      ) : null}

      <View style={styles.legend}>
        <View style={styles.legendGroup}>
          <View
            style={[styles.swatch, styles.todaySwatch, { backgroundColor: emptyFill, borderColor: brandColors.accent }]}
          />
          <Text variant="caption2" color={chartColors.secondaryLabel}>
            {t('stats.calendarToday')}
          </Text>
        </View>
        <View style={styles.legendGroup}>
          <Text variant="caption2" color={chartColors.secondaryLabel}>
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
              // oxlint-disable-next-line react/no-array-index-key -- a fixed four-step ramp; fills can repeat if the search hits its cap
              <View key={stepIndex} style={[styles.swatch, { backgroundColor: fill }]} />
            ))}
          </View>
          <Text variant="caption2" color={chartColors.secondaryLabel}>
            {t('stats.calendarMore')}
          </Text>
        </View>
      </View>
    </View>
  );
}

type WeekHitAreaProps = {
  columnIndex: number;
  left: number;
  width: number;
  accessibilityLabel: string;
  readOnly: boolean;
  onPress: (columnIndex: number, event: GestureResponderEvent) => void;
};

const WeekHitArea = memo(function WeekHitArea({
  columnIndex,
  left,
  width,
  accessibilityLabel,
  readOnly,
  onPress,
}: WeekHitAreaProps) {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => onPress(columnIndex, event),
    [onPress, columnIndex],
  );
  return (
    <Pressable
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
      onPress={readOnly ? undefined : handlePress}
      style={[styles.weekHitArea, { left, width }]}
    />
  );
});

const styles = StyleSheet.create({
  monthRow: {
    marginLeft: WEEKDAY_GUTTER + WEEKDAY_GUTTER_GAP,
    marginBottom: spacing[1],
  },
  monthRowSizer: {
    opacity: 0,
  },
  monthLabel: {
    position: 'absolute',
    top: 0,
  },
  gridRow: {
    flexDirection: 'row',
    gap: WEEKDAY_GUTTER_GAP,
  },
  weekdayGutter: {
    width: WEEKDAY_GUTTER,
  },
  weekdayLabel: {
    position: 'absolute',
    left: 0,
    right: 0,
    justifyContent: 'center',
  },
  weekHitArea: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  detail: {
    marginTop: spacing[2],
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing[2],
    marginTop: spacing[2],
  },
  legendGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
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
  todaySwatch: {
    borderWidth: TODAY_SWATCH_BORDER,
  },
});
