import type { GymBusyHour, GymBusyTimes, GymBusyWeekday, GymStats } from '@boardsesh/shared-schema';

type Translate = (key: string, values?: Record<string, string>) => string;
export type GymBusyTimesView = 'charts' | 'numbers';
export type GymBusyTimesSelection = {
  scope: string;
  view: GymBusyTimesView;
  weekday: number | null;
  hourlyCell: number | null;
  numberDay: number;
};

export function gymBusyTimesScope(stats: GymStats | undefined) {
  return stats ? JSON.stringify([stats.gymUuid, stats.boardUuid, stats.timeZone, stats.timeZoneConfigured]) : null;
}

export function defaultGymBusyTimesSelection(scope: string): GymBusyTimesSelection {
  return { scope, view: 'charts', weekday: null, hourlyCell: null, numberDay: 1 };
}

const HOURS_PER_DAY = 24;
const NOMINAL_DATES = 90;

type BusyCellState = 'missing' | 'insufficient' | 'zero' | 'positive';

function weekdayAt(dayOfWeek: number) {
  // January 1, 2024 was a Monday. Format the civil label without using the viewer's clock.
  return new Date(Date.UTC(2024, 0, dayOfWeek));
}

function wallHour(hour: number) {
  return new Date(Date.UTC(2024, 0, 1, hour));
}

function civilHourFormatter(locale: string, minute: boolean) {
  const options = { hour: 'numeric', minute: minute ? '2-digit' : undefined, timeZone: 'UTC' } as const;
  const parts = new Intl.DateTimeFormat(locale, options);
  return parts.resolvedOptions().hourCycle === 'h24'
    ? new Intl.DateTimeFormat(locale, { ...options, hourCycle: 'h23' })
    : parts;
}

function cellState(entry: GymBusyWeekday, insufficient: boolean): BusyCellState {
  if (entry.eligibleDates === 0) return 'missing';
  if (insufficient) return 'insufficient';
  return entry.recordedClimbers > 0 ? 'positive' : 'zero';
}

export function gymBusyTimesModel(report: GymBusyTimes, timeZone: string, locale: string, t: Translate) {
  const number = new Intl.NumberFormat(locale);
  const average = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  const shortWeekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const hour = civilHourFormatter(locale, true);
  const shortHour = civilHourFormatter(locale, false);
  const formatDate = (civilDate: string) => date.format(new Date(`${civilDate}T00:00:00Z`));
  const noDailyEvidence = report.weekdays.every((entry) => entry.recordedClimbers === 0);
  const noTimedEvidence = report.instantDisplays + report.instantTicks === 0;
  const omittedDaily = report.unplacedDateOnlyRecords + report.unknownTimeRecords;
  const omittedHourly = report.dateOnlyRecords + report.unknownTimeRecords;
  const dailyLimited = report.hasUnboundedUnknownTime || omittedDaily > 0;
  const hourlyLimited = report.hasUnboundedUnknownTime || omittedHourly > 0;
  const dailyInsufficient = report.status === 'ready' && noDailyEvidence && dailyLimited;
  const hourlyInsufficient = report.status === 'ready' && noTimedEvidence && hourlyLimited;
  const daySource = t('gymBusyTimes.daySource');
  const hourSource = t('gymBusyTimes.hourSource');
  const hourLabels = Array.from({ length: HOURS_PER_DAY }, (_, hourIndex) => shortHour.format(wallHour(hourIndex)));

  const makeCell = (entry: GymBusyWeekday | GymBusyHour, insufficient: boolean, incomplete: boolean) => {
    const weekdayLabel = weekday.format(weekdayAt(entry.dayOfWeek));
    const isHour = 'hour' in entry;
    const hourLabel = isHour
      ? t('gymBusyTimes.hourSpan', {
          start: hour.format(wallHour(entry.hour)),
          end: hour.format(wallHour(entry.hour + 1)),
        })
      : '';
    const label = isHour ? t('gymBusyTimes.dayHour', { day: weekdayLabel, hour: hourLabel }) : weekdayLabel;
    const source = isHour ? hourSource : daySource;
    const state = cellState(entry, insufficient);
    const rounded = state === 'positive' ? Math.round((entry.recordedClimbers * 10) / entry.eligibleDates) / 10 : 0;
    const dateCount = number.format(entry.eligibleDates);
    const recordedCount = number.format(entry.recordedClimbers);
    const averageText =
      state === 'missing' || state === 'insufficient' ? t('gymBusyTimes.unavailable') : average.format(rounded);
    const detail =
      state === 'missing'
        ? t('gymBusyTimes.noDates', { label })
        : state === 'insufficient'
          ? t('gymBusyTimes.missingDetail', { label, dates: dateCount })
          : isHour
            ? t('gymBusyTimes.hourDetail', { label, average: averageText, total: recordedCount, dates: dateCount })
            : t('gymBusyTimes.dayDetail', { label, average: averageText, total: recordedCount, dates: dateCount });
    const limited = incomplete ? t('gymBusyTimes.timingLimited') : '';
    return {
      key: isHour ? (entry.dayOfWeek - 1) * HOURS_PER_DAY + entry.hour : entry.dayOfWeek,
      label,
      axisLabel: isHour ? hourLabel : shortWeekday.format(weekdayAt(entry.dayOfWeek)),
      state,
      rounded,
      averageText,
      dateCount,
      recordedCount: state === 'missing' || state === 'insufficient' ? t('gymBusyTimes.unavailable') : recordedCount,
      detail,
      source,
      limited,
      accessibilityLabel: [detail, source, limited].filter(Boolean).join(' '),
    };
  };

  const dailyCells = report.weekdays.map((entry) => makeCell(entry, dailyInsufficient, dailyLimited));
  const hourlyCells = report.hours.map((entry) => makeCell(entry, hourlyInsufficient, hourlyLimited));
  type Cell = (typeof dailyCells)[number];
  function peak(cells: Cell[]) {
    // API order is Monday–Sunday then 00:00–23:00. Keep the first displayed tie.
    return cells.reduce<Cell | null>(
      (best, cell) => (cell.rounded > 0 && (!best || cell.rounded > best.rounded) ? cell : best),
      null,
    );
  }
  const dailyPeak = peak(dailyCells);
  const hourlyPeak = peak(hourlyCells);
  const dailyMax = dailyPeak?.rounded ?? 0;
  const hourlyMax = hourlyPeak?.rounded ?? 0;
  const ranges =
    report.startDate && report.endDate
      ? t('gymBusyTimes.observation', {
          start: formatDate(report.startDate),
          end: formatDate(report.endDate),
          zone: timeZone,
          days: number.format(NOMINAL_DATES),
        })
      : '';
  const selectedCoverage = report.firstCoveredDate
    ? t('gymBusyTimes.coveredFrom', {
        count: number.format(report.coveredDates),
        total: number.format(NOMINAL_DATES),
        start: formatDate(report.firstCoveredDate),
      })
    : t('gymBusyTimes.coveredNone');

  return {
    ranges,
    coverage: selectedCoverage,
    status:
      report.status === 'zoneRequired'
        ? t('gymBusyTimes.zoneRequired')
        : report.status === 'calendarUnavailable'
          ? t('gymBusyTimes.calendarUnavailable')
          : report.status === 'historyUnavailable'
            ? t('gymBusyTimes.historyUnavailable')
            : '',
    dailyNotice: dailyInsufficient ? t('gymBusyTimes.dailyInsufficient') : '',
    hourlyNotice: hourlyInsufficient ? t('gymBusyTimes.hourlyInsufficient') : '',
    daySource,
    hourSource,
    timedSources: t('gymBusyTimes.timedSources', {
      displays: number.format(report.instantDisplays),
      ticks: number.format(report.instantTicks),
    }),
    unboundedNotice: report.hasUnboundedUnknownTime ? t('gymBusyTimes.unboundedTiming') : '',
    timingNotice:
      omittedHourly > 0
        ? t('gymBusyTimes.timingNotice', {
            dated: number.format(report.dateOnlyRecords),
            unplaced: number.format(report.unplacedDateOnlyRecords),
            unknown: number.format(report.unknownTimeRecords),
          })
        : '',
    dailySummary: dailyPeak
      ? t('gymBusyTimes.dailySummary', { day: dailyPeak.label, average: dailyPeak.averageText })
      : '',
    hourlySummary: hourlyPeak
      ? t('gymBusyTimes.hourlySummary', { time: hourlyPeak.label, average: hourlyPeak.averageText })
      : '',
    dailyScale: t('gymBusyTimes.scale', { max: average.format(dailyMax) }),
    hourlyScale: t('gymBusyTimes.scale', { max: average.format(hourlyMax) }),
    dailyCells: dailyCells.map((cell) => ({ ...cell, intensity: dailyMax ? cell.rounded / dailyMax : 0 })),
    hourlyRows: dailyCells.map((day, index) => ({
      day,
      hours: hourlyCells.slice(index * HOURS_PER_DAY, (index + 1) * HOURS_PER_DAY).map((cell) => ({
        ...cell,
        intensity: hourlyMax ? Math.ceil((cell.rounded / hourlyMax) * 4) / 4 : 0,
      })),
    })),
    hourLabels,
  };
}

export function nextGymBusyHour(current: number, key: string) {
  const hour = current % HOURS_PER_DAY;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(current - hour, current - 1);
    case 'ArrowRight':
      return Math.min(current - hour + HOURS_PER_DAY - 1, current + 1);
    case 'ArrowUp':
      return current < HOURS_PER_DAY ? current : current - HOURS_PER_DAY;
    case 'ArrowDown':
      return current >= 6 * HOURS_PER_DAY ? current : current + HOURS_PER_DAY;
    case 'Home':
      return current - hour;
    case 'End':
      return current - hour + HOURS_PER_DAY - 1;
    default:
      return null;
  }
}

export type GymBusyTimesModel = ReturnType<typeof gymBusyTimesModel>;
export type GymBusyTimesCell = GymBusyTimesModel['dailyCells'][number];
