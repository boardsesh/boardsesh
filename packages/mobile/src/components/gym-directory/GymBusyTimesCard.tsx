import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
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
import { borderRadius, spacing } from '../../theme/tokens';
import { StaticPressableSurface } from '../PressableSurface';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';

type BusyTimesProps = { report?: GymBusyTimes | null; timeZone?: string; scope: string | null };

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

function BusyCharts({
  model,
  selection,
  update,
}: {
  model: GymBusyTimesModel;
  selection: GymBusyTimesSelection;
  update: (patch: Partial<GymBusyTimesSelection>) => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors, selection: selectionColors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const cellWidth = 48 * Math.max(1, fontScale);
  const dayWidth = Math.max(64, cellWidth);
  return (
    <>
      <View style={styles.subsection}>
        <Text accessibilityRole="header" variant="subheadline">
          {t('gymBusyTimes.weekdays')}
        </Text>
        {!!model.dailyNotice && <Text variant="footnote">{model.dailyNotice}</Text>}
        <Text variant="footnote">{t('gymBusyTimes.dailyMeasure')}</Text>
        <Legend label={model.dailyScale} hasValues={!!model.dailySummary} />
        {model.dailyCells.map((cell) => {
          const selected = selection.weekday === cell.key;
          return (
            <StaticPressableSurface
              key={cell.key}
              accessibilityLabel={cell.accessibilityLabel}
              accessibilityState={{ selected }}
              onPress={() => update({ weekday: cell.key })}
              onFocus={() => update({ weekday: cell.key })}
              style={[styles.barRow, { borderColor: selected ? selectionColors.checkmark : systemColors.separator }]}
            >
              <Text variant="subheadline" style={{ minWidth: dayWidth }}>
                {cell.axisLabel}
              </Text>
              <View style={[styles.barTrack, { backgroundColor: systemColors.secondaryBackground }]} accessible={false}>
                {cell.intensity > 0 && (
                  <View
                    style={[
                      styles.barFill,
                      { width: `${cell.intensity * 100}%`, backgroundColor: brandColors.primary },
                    ]}
                  />
                )}
              </View>
              <Text variant="subheadline" numeric>
                {cell.averageText}
              </Text>
            </StaticPressableSurface>
          );
        })}
        <Detail cell={model.dailyCells.find((cell) => cell.key === selection.weekday)} />
      </View>
      <View style={styles.subsection}>
        <Text accessibilityRole="header" variant="subheadline">
          {t('gymBusyTimes.hours')}
        </Text>
        {!!model.hourlyNotice && <Text variant="footnote">{model.hourlyNotice}</Text>}
        <Text variant="footnote">{t('gymBusyTimes.hourlyMeasure')}</Text>
        <Legend label={model.hourlyScale} hasValues={!!model.hourlySummary} />
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('gymBusyTimes.scrollHours')}
        </Text>
        <ScrollView horizontal contentContainerStyle={styles.heatmap} showsHorizontalScrollIndicator>
          <View style={styles.heatRow} accessible={false}>
            <View style={{ width: dayWidth }} />
            {model.hourLabels.map((label, index) => (
              <View key={index} style={[styles.axisCell, { width: cellWidth }]}>
                <Text variant="caption1" style={styles.center}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
          {model.hourlyRows.map(({ day, hours }) => (
            <View key={day.key} style={styles.heatRow}>
              <View style={[styles.axisCell, { width: dayWidth }]}>
                <Text variant="caption1" style={styles.center}>
                  {day.axisLabel}
                </Text>
              </View>
              {hours.map((cell) => {
                const selected = selection.hourlyCell === cell.key;
                const missing = cell.state === 'missing' || cell.state === 'insufficient';
                return (
                  <StaticPressableSurface
                    key={cell.key}
                    accessibilityLabel={cell.accessibilityLabel}
                    accessibilityState={{ selected }}
                    onPress={() => update({ hourlyCell: cell.key })}
                    onFocus={() => update({ hourlyCell: cell.key })}
                    style={[
                      styles.heatCell,
                      {
                        width: cellWidth,
                        borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
                        borderStyle: missing ? 'dashed' : 'solid',
                        borderColor: selected ? selectionColors.checkmark : systemColors.separator,
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
              })}
            </View>
          ))}
        </ScrollView>
        <Detail
          cell={model.hourlyRows.flatMap(({ hours }) => hours).find((cell) => cell.key === selection.hourlyCell)}
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
  if (scope && remembered?.scope !== scope) setRemembered(defaultGymBusyTimesSelection(scope));
  if (!model || !remembered || remembered.scope !== scope) return null;
  const update = (patch: Partial<GymBusyTimesSelection>) =>
    setRemembered((current) => (current && current.scope === scope ? { ...current, ...patch } : current));
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
            onSelect={(view) => update({ view })}
            accessibilityLabel={t('gymBusyTimes.view')}
          />
          {remembered.view === 'charts' ? (
            <BusyCharts model={model} selection={remembered} update={update} />
          ) : (
            <BusyNumbers model={model} day={remembered.numberDay} selectDay={(numberDay) => update({ numberDay })} />
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
  heatmap: { flexDirection: 'column', gap: spacing[1], alignItems: 'flex-start', paddingBottom: spacing[1] },
  heatRow: { flexDirection: 'row', gap: spacing[1] },
  axisCell: { alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  heatCell: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: borderRadius.sm },
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
