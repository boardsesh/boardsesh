import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';

type TFunc = (key: string) => string;

// Literal t() calls (not t(variable)) so the i18n key extractor + orphan checker
// see every key, and so the lint rule against dynamic keys stays happy.
function weekdayLabel(day: number, t: TFunc): string {
  switch (day) {
    case 0:
      return t('detail.weekday.sunday');
    case 1:
      return t('detail.weekday.monday');
    case 2:
      return t('detail.weekday.tuesday');
    case 3:
      return t('detail.weekday.wednesday');
    case 4:
      return t('detail.weekday.thursday');
    case 5:
      return t('detail.weekday.friday');
    default:
      return t('detail.weekday.saturday');
  }
}

function partOfDayLabel(hour: number, t: TFunc): string {
  if (hour >= 5 && hour < 12) return t('detail.partOfDay.morning');
  if (hour >= 12 && hour < 17) return t('detail.partOfDay.afternoon');
  if (hour >= 17 && hour < 21) return t('detail.partOfDay.evening');
  return t('detail.partOfDay.night');
}

/**
 * Human "when" for an unnamed session's second line: localized weekday +
 * part-of-day, e.g. "Sunday morning". `climbedAt` is a UTC string; we read the
 * LOCAL weekday/hour so it matches the climber's day. dayjs locale isn't wired
 * app-wide, so both words come from i18n (the `t` passed in, bound to the
 * `session` namespace) rather than dayjs formatting.
 */
export function formatSessionWhen(climbedAt: string, t: TFunc): string {
  // `formatTickAbsoluteTime` parses the UTC string and emits LOCAL time, so the
  // 'd' (day-of-week 0-6) and 'H' (hour 0-23) tokens give the climber's local
  // weekday/hour without a direct dayjs dependency here.
  const day = Number(formatTickAbsoluteTime(climbedAt, 'd'));
  const hour = Number(formatTickAbsoluteTime(climbedAt, 'H'));
  return `${weekdayLabel(day, t)} ${partOfDayLabel(hour, t)}`;
}
