import type {
  GymReachCount,
  GymReachCoverage,
  GymReachOverview,
  GymReachReturn,
  GymStats,
} from '@boardsesh/shared-schema';
import { formatGymReportingTime } from './gym-reporting';

type Translate = (key: string, values?: Record<string, string>) => string;
export type GymTrendMetric = 'climbers' | 'sends';
export type GymTrendSelection = {
  metric: GymTrendMetric;
  setMetric: (metric: GymTrendMetric) => void;
  week: string | null;
  setWeek: (week: string | null) => void;
};

export function gymReachCards(stats: GymStats, overview: GymReachOverview, locale: string, t: Translate) {
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const decimals = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const sign = (value: number, formatted: string) => (value > 0 ? `+${formatted}` : formatted);
  const countValue = (entry: GymReachCount) =>
    entry.coverage === 'unavailable' ? t('gymReach.noValue') : number.format(entry.count);

  function countComparison(current: GymReachCount, previous: GymReachCount) {
    if (current.coverage !== 'complete' || previous.coverage !== 'complete') return t('gymReach.compareHistory');
    if (previous.count === 0) return t('gymReach.compareZero');
    const difference = current.count - previous.count;
    return t('gymReach.countComparison', {
      change: sign(difference, number.format(difference)),
      percent: sign(difference, percent.format(difference / previous.count)),
    });
  }

  const rate = (value: GymReachReturn) =>
    value.coverage === 'complete' && value.previousClimbers > 0 ? value.returning / value.previousClimbers : null;
  const currentRate = rate(overview.cameBack);
  const previousRate = rate(overview.previousCameBack);
  const comparison = (() => {
    if (currentRate === null) {
      return overview.cameBack.previousClimbers === 0 ? t('gymReach.noReturnCohort') : t('gymReach.returnHistory');
    }
    if (previousRate === null) {
      return overview.previousCameBack.previousClimbers === 0
        ? t('gymReach.noEarlierCohort')
        : t('gymReach.compareHistory');
    }
    if (previousRate === 0) return t('gymReach.compareZero');
    const difference = currentRate - previousRate;
    return t('gymReach.rateComparison', {
      points: sign(difference, decimals.format(100 * difference)),
      percent: sign(difference, percent.format(difference / previousRate)),
    });
  })();

  const { current, previous } = overview;
  const baselineStart = formatGymReportingTime(overview.baselineStartAt, stats.timeZone, locale);
  const baselineEnd = formatGymReportingTime(stats.previous.startAt, stats.timeZone, locale);
  const countNote = (coverage: GymReachCoverage) =>
    coverage === 'partial' ? t('gymReach.partial') : coverage === 'unavailable' ? t('gymReach.missing') : '';

  return [
    {
      key: 'climbers',
      title: t('gymReach.climbers'),
      value: countValue(current.climbers),
      description: t('gymReach.climbersDefinition'),
      comparison: countComparison(current.climbers, previous.climbers),
      note: countNote(current.climbers.coverage),
    },
    {
      key: 'first',
      title: t('gymReach.first'),
      value: countValue(current.firstRecorded),
      description: t('gymReach.firstDefinition'),
      comparison: countComparison(current.firstRecorded, previous.firstRecorded),
      note:
        current.uncertainFirstRecorded > 0
          ? t('gymReach.firstUncertain', { countText: number.format(current.uncertainFirstRecorded) })
          : countNote(current.firstRecorded.coverage),
    },
    {
      key: 'returned',
      title: t('gymReach.returned'),
      value: currentRate === null ? t('gymReach.noValue') : percent.format(currentRate),
      description: t('gymReach.returnedDefinition', {
        returning: number.format(overview.cameBack.returning),
        previous: number.format(overview.cameBack.previousClimbers),
      }),
      comparison,
      note: t('gymReach.returnBaseline', { start: baselineStart, end: baselineEnd }),
    },
    {
      key: 'sends',
      title: t('gymReach.sends'),
      value: countValue(current.sends),
      description: t('gymReach.sendLoggers', { countText: number.format(current.sendLoggers) }),
      comparison: countComparison(current.sends, previous.sends),
      note: countNote(current.sends.coverage),
    },
    {
      key: 'sessions',
      title: t('gymReach.sessions'),
      value: countValue(current.sessions),
      description: t('gymReach.sessionsDefinition'),
      comparison: countComparison(current.sessions, previous.sessions),
      note: countNote(current.sessions.coverage),
    },
  ];
}

export function gymReachTrend(
  weeks: GymReachOverview['weeklyTrend'],
  metric: GymTrendMetric,
  selectedWeek: string | null,
  locale: string,
  t: Translate,
) {
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const number = new Intl.NumberFormat(locale);
  const maxCount = Math.max(1, ...weeks.map((week) => week[metric].count));
  const calendarDate = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
  const bars = weeks.map((week) => {
    const entry = week[metric];
    const progress = week.inProgress ? t('gymReach.inProgress') : null;
    const coverage =
      entry.coverage === 'unavailable'
        ? t('gymReach.missing')
        : entry.coverage === 'partial'
          ? t('gymReach.partial')
          : null;
    const value =
      entry.coverage === 'unavailable'
        ? t('gymReach.missing')
        : metric === 'climbers'
          ? t('gymReach.weekClimbers', { countText: number.format(entry.count) })
          : t('gymReach.weekSends', { countText: number.format(entry.count) });
    const detail = t('gymReach.weekDetail', {
      start: date.format(calendarDate(week.startDate)),
      end: date.format(calendarDate(week.endDate)),
      value,
    });
    return {
      key: week.startDate,
      label: day.format(calendarDate(week.startDate)),
      fraction: entry.coverage === 'unavailable' ? 0 : entry.count / maxCount,
      progress,
      coverage,
      detail,
      accessibilityLabel: [detail, progress, coverage === value ? null : coverage].filter(Boolean).join('. '),
    };
  });
  return { bars, selected: bars.find(({ key }) => key === selectedWeek) ?? bars.at(-1) };
}
