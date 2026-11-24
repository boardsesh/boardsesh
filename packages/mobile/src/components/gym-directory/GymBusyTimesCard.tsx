import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { FlashList, type FlashListProps, type FlashListRef, type ListRenderItem } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import {
  defaultGymBusyTimesSelection,
  gymBusyTimesModel,
  type GymBusyTimesCell,
  type GymBusyTimesModel,
  type GymBusyTimesSelection,
  type GymBusyTimesView,
} from '@boardsesh/graphql';
import type { GymBusyTimes } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { textFontScale } from '../../theme/dynamic-type';
import { borderRadius, spacing } from '../../theme/tokens';
import { textStyles as defaultTextStyles } from '../../theme/typography';
import { StaticPressableSurface } from '../PressableSurface';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';

type BusyTimesProps = { report?: GymBusyTimes | null; timeZone?: string; scope: string | null };
type SelectionField = Exclude<keyof GymBusyTimesSelection, 'scope'>;
type UpdateSelection = <Field extends SelectionField>(field: Field, value: GymBusyTimesSelection[Field]) => void;

const MIN_TOUCH_SIZE = 48;
const SELECTED_BORDER_WIDTH = 2;
const HEATMAP_GAP = spacing[1];
const isWeb = Platform.OS === 'web';
const webHourViewability = { itemVisiblePercentThreshold: 100, minimumViewTime: 0 };

type HourColumn = {
  hour: number;
  label: string;
  days: { weekday: number; cell?: GymBusyTimesCell }[];
};

const hourColumnKey = (column: HourColumn) => String(column.hour);

function Detail({ cell }: { cell: GymBusyTimesCell | undefined }) {
  const { systemColors } = useTheme();
  if (!cell) return null;
  return (
    <View style={styles.details}>
      <Text variant="subheadline" accessibilityLiveRegion="polite">
        {cell.detail}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {cell.source} {cell.limited}
      </Text>
    </View>
  );
}

function Legend({ label, hasValues }: { label: string; hasValues: boolean }) {
  const { systemColors, brandColors } = useTheme();
  return (
    <View style={styles.legend}>
      {hasValues && (
        <View style={styles.legend} accessible={false}>
          {[0.125, 0.25, 0.375, 0.5].map((opacity) => (
            <View
              key={opacity}
              style={[
                styles.swatch,
                {
                  borderColor: systemColors.separator,
                  backgroundColor: withAlpha(brandColors.primary, opacity),
                },
              ]}
            />
          ))}
        </View>
      )}
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {label}
      </Text>
    </View>
  );
}

const WeekdayBar = memo(function WeekdayBar({
  cell,
  selected,
  dayWidth,
  onSelect,
}: {
  cell: GymBusyTimesCell;
  selected: boolean;
  dayWidth: number;
  onSelect: (key: number) => void;
}) {
  const { systemColors, brandColors, selection } = useTheme();
  const select = useCallback(() => onSelect(cell.key), [cell.key, onSelect]);
  return (
    <StaticPressableSurface
      accessibilityLabel={cell.accessibilityLabel}
      accessibilityState={{ selected }}
      aria-current={isWeb && selected ? 'true' : undefined}
      onPress={select}
      onFocus={select}
      style={[styles.barRow, { borderColor: selected ? selection.checkmark : systemColors.separator }]}
    >
      <Text variant="subheadline" style={{ minWidth: dayWidth }}>
        {cell.axisLabel}
      </Text>
      <View style={[styles.barTrack, { backgroundColor: systemColors.secondaryBackground }]} accessible={false}>
        {cell.intensity > 0 && (
          <View style={[styles.barFill, { width: `${cell.intensity * 100}%`, backgroundColor: brandColors.primary }]} />
        )}
      </View>
      <Text variant="subheadline" numeric>
        {cell.averageText}
      </Text>
    </StaticPressableSurface>
  );
});

const HourCell = memo(function HourCell({
  cell,
  selected,
  height,
  tabIndex,
  onSelect,
}: {
  cell: GymBusyTimesCell;
  selected: boolean;
  height: number;
  tabIndex: 0 | -1 | undefined;
  onSelect: (key: number) => void;
}) {
  const { systemColors, brandColors, selection } = useTheme();
  const select = useCallback(() => onSelect(cell.key), [cell.key, onSelect]);
  const missing = cell.state === 'missing' || cell.state === 'insufficient';
  return (
    <StaticPressableSurface
      accessibilityLabel={cell.accessibilityLabel}
      accessibilityState={{ selected }}
      aria-current={isWeb && selected ? 'true' : undefined}
      tabIndex={tabIndex}
      onPress={select}
      onFocus={select}
      style={[
        styles.heatCell,
        {
          height,
          borderWidth: selected ? SELECTED_BORDER_WIDTH : StyleSheet.hairlineWidth,
          borderStyle: missing ? 'dashed' : 'solid',
          borderColor: selected ? selection.checkmark : systemColors.separator,
          backgroundColor: cell.intensity
            ? withAlpha(brandColors.primary, cell.intensity * 0.5)
            : systemColors.secondaryBackground,
        },
      ]}
    >
      <Text variant="caption1" numeric>
        {cell.state === 'positive' ? '•' : cell.averageText}
      </Text>
    </StaticPressableSurface>
  );
});

function AxisLabel({ label, height }: { label?: string; height: number }) {
  return (
    <View style={[styles.axisCell, { height }]}>
      {!!label && (
        <Text variant="caption1" style={styles.center}>
          {label}
        </Text>
      )}
    </View>
  );
}

const HeatmapColumn = memo(function HeatmapColumn({
  column,
  selectedKey,
  cellWidth,
  axisHeight,
  rowHeight,
  tabIndex,
  onSelect,
}: {
  column: HourColumn;
  selectedKey: number | null;
  cellWidth: number;
  axisHeight: number;
  rowHeight: number;
  tabIndex: 0 | -1 | undefined;
  onSelect: (key: number) => void;
}) {
  return (
    <View style={[styles.heatColumn, { width: cellWidth }]}>
      <AxisLabel label={column.label} height={axisHeight} />
      {column.days.map(({ weekday, cell }) =>
        cell ? (
          <HourCell
            key={weekday}
            cell={cell}
            selected={cell.key === selectedKey}
            height={rowHeight}
            tabIndex={tabIndex}
            onSelect={onSelect}
          />
        ) : (
          <View key={weekday} style={{ height: rowHeight }} />
        ),
      )}
    </View>
  );
});

function HourColumnGap() {
  return <View style={styles.hourColumnGap} />;
}

const HourlyHeatmap = memo(function HourlyHeatmap({
  model,
  selectedKey,
  cellWidth,
  dayWidth,
  fontScale,
  label,
  onSelect,
}: {
  model: GymBusyTimesModel;
  selectedKey: number | null;
  cellWidth: number;
  dayWidth: number;
  fontScale: number;
  label: string;
  onSelect: (key: number) => void;
}) {
  const { textStyles } = useTheme();
  const list = useRef<FlashListRef<HourColumn>>(null);
  const [visibleHours, setVisibleHours] = useState<ReadonlySet<number>>(() => new Set());
  const updateVisibleHours = useCallback<NonNullable<FlashListProps<HourColumn>['onViewableItemsChanged']>>(
    ({ viewableItems }) => {
      const next = new Set(viewableItems.map(({ item }) => item.hour));
      setVisibleHours((current) =>
        current.size === next.size && [...next].every((hour) => current.has(hour)) ? current : next,
      );
    },
    [],
  );
  const preserveWebFocus = useCallback(() => {
    const viewport = list.current?.getNativeScrollRef();
    if (!(viewport instanceof HTMLElement)) return;
    const focusedCell = viewport.ownerDocument.activeElement;
    if (!focusedCell || focusedCell === viewport || !viewport.contains(focusedCell)) return;
    // The recycler can reuse the DOM node once its cell has scrolled away.
    const cellBounds = focusedCell.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    if (cellBounds.right <= viewportBounds.left || cellBounds.left >= viewportBounds.right) {
      viewport.focus({ preventScroll: true });
    }
  }, []);
  const captionLineHeight = textStyles.caption1.lineHeight ?? defaultTextStyles.caption1.lineHeight;
  const axisHeight = Math.ceil(captionLineHeight * textFontScale('caption1', fontScale, Platform.OS));
  const rowHeight = Math.max(MIN_TOUCH_SIZE, axisHeight + SELECTED_BORDER_WIDTH * 2);
  const height = axisHeight + model.hourlyRows.length * (rowHeight + HEATMAP_GAP) + spacing[1];
  const { columns, cellsByKey } = useMemo(() => {
    const cellsByKey = new Map<number, { hour: number; cell: GymBusyTimesCell }>();
    const columns = model.hourLabels.map((label, hour) => ({
      hour,
      label,
      days: model.hourlyRows.map(({ day, hours }) => {
        const cell = hours[hour];
        if (cell) cellsByKey.set(cell.key, { hour, cell });
        return { weekday: day.key, cell };
      }),
    }));
    return { columns, cellsByKey };
  }, [model]);
  const weekdayAxis = useMemo(
    () => (
      <View style={[styles.heatColumn, styles.weekdayAxis, { width: dayWidth }]}>
        <AxisLabel height={axisHeight} />
        {model.hourlyRows.map(({ day }) => (
          <AxisLabel key={day.key} label={day.axisLabel} height={rowHeight} />
        ))}
      </View>
    ),
    [axisHeight, dayWidth, model.hourlyRows, rowHeight],
  );
  const renderItem = useCallback<ListRenderItem<HourColumn>>(
    ({ item, extraData }) => {
      const selectedCell = typeof extraData === 'number' ? cellsByKey.get(extraData) : undefined;
      return (
        <HeatmapColumn
          column={item}
          selectedKey={selectedCell?.hour === item.hour ? selectedCell.cell.key : null}
          cellWidth={cellWidth}
          axisHeight={axisHeight}
          rowHeight={rowHeight}
          tabIndex={isWeb ? (visibleHours.has(item.hour) ? 0 : -1) : undefined}
          onSelect={onSelect}
        />
      );
    },
    [axisHeight, cellsByKey, cellWidth, onSelect, rowHeight, visibleHours],
  );
  return (
    <>
      <FlashList
        ref={list}
        horizontal
        data={columns}
        keyExtractor={hourColumnKey}
        renderItem={renderItem}
        extraData={selectedKey}
        ListHeaderComponent={weekdayAxis}
        ItemSeparatorComponent={HourColumnGap}
        drawDistance={2 * (cellWidth + HEATMAP_GAP)}
        style={{ height }}
        contentContainerStyle={styles.heatmapContent}
        showsHorizontalScrollIndicator
        role={isWeb ? 'region' : undefined}
        accessibilityLabel={isWeb ? label : undefined}
        tabIndex={isWeb ? 0 : undefined}
        onScroll={isWeb ? preserveWebFocus : undefined}
        viewabilityConfig={isWeb ? webHourViewability : undefined}
        onViewableItemsChanged={isWeb ? updateVisibleHours : undefined}
        testID="gym-busy-times-heatmap"
      />
      <Detail cell={selectedKey === null ? undefined : cellsByKey.get(selectedKey)?.cell} />
    </>
  );
});

function BusyCharts({
  model,
  selection,
  update,
}: {
  model: GymBusyTimesModel;
  selection: GymBusyTimesSelection;
  update: UpdateSelection;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const cellWidth = MIN_TOUCH_SIZE * Math.max(1, fontScale);
  const dayWidth = Math.max(64, cellWidth);
  const hoursLabel = t('gymBusyTimes.hours');
  const selectWeekday = useCallback((key: number) => update('weekday', key), [update]);
  const selectHour = useCallback((key: number) => update('hourlyCell', key), [update]);
  return (
    <>
      <View style={styles.subsection}>
        <Text accessibilityRole="header" variant="subheadline">
          {t('gymBusyTimes.weekdays')}
        </Text>
        {!!model.dailyNotice && <Text variant="footnote">{model.dailyNotice}</Text>}
        <Text variant="footnote">{t('gymBusyTimes.dailyMeasure')}</Text>
        <Legend label={model.dailyScale} hasValues={!!model.dailySummary} />
        {model.dailyCells.map((cell) => (
          <WeekdayBar
            key={cell.key}
            cell={cell}
            selected={selection.weekday === cell.key}
            dayWidth={dayWidth}
            onSelect={selectWeekday}
          />
        ))}
        <Detail cell={model.dailyCells.find((cell) => cell.key === selection.weekday)} />
      </View>
      <View style={styles.subsection}>
        <Text accessibilityRole="header" variant="subheadline">
          {hoursLabel}
        </Text>
        {!!model.hourlyNotice && <Text variant="footnote">{model.hourlyNotice}</Text>}
        <Text variant="footnote">{t('gymBusyTimes.hourlyMeasure')}</Text>
        <Legend label={model.hourlyScale} hasValues={!!model.hourlySummary} />
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('gymBusyTimes.scrollHours')}
        </Text>
        <HourlyHeatmap
          model={model}
          selectedKey={selection.hourlyCell}
          cellWidth={cellWidth}
          dayWidth={dayWidth}
          fontScale={fontScale}
          label={hoursLabel}
          onSelect={selectHour}
        />
      </View>
    </>
  );
}

function NumericRows({ cells }: { cells: GymBusyTimesCell[] }) {
  const { systemColors } = useTheme();
  return (
    <View>
      {cells.map((cell) => (
        <View
          key={cell.key}
          accessible
          accessibilityLabel={cell.accessibilityLabel}
          style={[styles.numberRow, { borderColor: systemColors.separator }]}
        >
          <Text variant="subheadline">{cell.detail}</Text>
        </View>
      ))}
    </View>
  );
}

function BusyNumbers({
  model,
  day,
  selectDay,
}: {
  model: GymBusyTimesModel;
  day: number;
  selectDay: (day: number) => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors, selection } = useTheme();
  const selected = model.hourlyRows.find((row) => row.day.key === day);
  return (
    <View style={styles.subsection}>
      <Text accessibilityRole="header" variant="subheadline">
        {t('gymBusyTimes.weekdays')}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {model.daySource}
      </Text>
      <NumericRows cells={model.dailyCells} />
      <Text accessibilityRole="header" variant="subheadline">
        {t('gymBusyTimes.hours')}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {model.hourSource}
      </Text>
      <Text variant="subheadline">{t('gymBusyTimes.hourTableDay')}</Text>
      <View style={styles.dayChoices}>
        {model.dailyCells.map((cell) => (
          <StaticPressableSurface
            key={cell.key}
            accessibilityLabel={cell.label}
            accessibilityState={{ selected: day === cell.key }}
            aria-current={isWeb && day === cell.key ? 'true' : undefined}
            onPress={() => selectDay(cell.key)}
            style={[styles.dayChoice, { borderColor: day === cell.key ? selection.checkmark : systemColors.separator }]}
          >
            <Text variant="subheadline">{cell.axisLabel}</Text>
          </StaticPressableSurface>
        ))}
      </View>
      {selected && <NumericRows cells={selected.hours} />}
    </View>
  );
}

export function GymBusyTimesCard({ report, timeZone, scope }: BusyTimesProps) {
  const { t, i18n } = useTranslation('boards');
  const { systemColors } = useTheme();
  const locale = i18n.language || 'en-US';
  const model = useMemo(
    () => (report && timeZone ? gymBusyTimesModel(report, timeZone, locale, t) : null),
    [report, timeZone, locale, t],
  );
  const [remembered, setRemembered] = useState<GymBusyTimesSelection | null>(null);
  const update = useCallback<UpdateSelection>(
    (field, value) =>
      setRemembered((current) =>
        current && current.scope === scope && current[field] !== value ? { ...current, [field]: value } : current,
      ),
    [scope],
  );
  if (scope && remembered?.scope !== scope) setRemembered(defaultGymBusyTimesSelection(scope));
  if (!model || !remembered || remembered.scope !== scope) return null;
  const hasCalendar = report?.status === 'ready' || report?.status === 'historyUnavailable';
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" variant="headline">
        {t('gymBusyTimes.title')}
      </Text>
      {!!model.ranges && <Text variant="subheadline">{model.ranges}</Text>}
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {model.coverage}
      </Text>
      {!!model.status && <Text variant="subheadline">{model.status}</Text>}
      {!!(model.dailySummary || model.hourlySummary) && (
        <View style={styles.details}>
          <Text accessibilityRole="header" variant="subheadline">
            {t('gymBusyTimes.busiestTitle')}
          </Text>
          <Text variant="subheadline">{[model.dailySummary, model.hourlySummary].filter(Boolean).join(' ')}</Text>
        </View>
      )}
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('gymBusyTimes.population')}
      </Text>
      {report?.status === 'ready' && (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {model.timedSources}
        </Text>
      )}
      {!!model.timingNotice && (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {model.timingNotice}
        </Text>
      )}
      {!!model.unboundedNotice && (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {model.unboundedNotice}
        </Text>
      )}
      {hasCalendar && (
        <>
          <SegmentedControl<GymBusyTimesView>
            options={[
              { key: 'charts', label: t('gymBusyTimes.charts') },
              { key: 'numbers', label: t('gymBusyTimes.numbers') },
            ]}
            selectedKey={remembered.view}
            onSelect={(view) => update('view', view)}
            accessibilityLabel={t('gymBusyTimes.view')}
          />
          {remembered.view === 'charts' ? (
            <BusyCharts model={model} selection={remembered} update={update} />
          ) : (
            <BusyNumbers
              model={model}
              day={remembered.numberDay}
              selectDay={(numberDay) => update('numberDay', numberDay)}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[2], minWidth: 0 },
  subsection: { gap: spacing[1], minWidth: 0 },
  details: { gap: spacing[1] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[1] },
  swatch: { width: 12, height: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: borderRadius.sm },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing[2],
  },
  barTrack: { flex: 1, height: 12, borderRadius: borderRadius.sm },
  barFill: { height: '100%', borderRadius: borderRadius.sm },
  heatmapContent: { paddingBottom: spacing[1] },
  heatColumn: { gap: HEATMAP_GAP },
  hourColumnGap: { width: HEATMAP_GAP },
  weekdayAxis: { marginEnd: HEATMAP_GAP },
  axisCell: { alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  heatCell: { alignItems: 'center', justifyContent: 'center', borderRadius: borderRadius.sm },
  numberRow: { paddingVertical: spacing[2], borderBottomWidth: StyleSheet.hairlineWidth },
  dayChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1] },
  dayChoice: {
    minHeight: 48,
    minWidth: 48,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
    borderRadius: borderRadius.sm,
  },
});
