import { parseTickTime } from '@boardsesh/profile-stats';
import { getCachedDateTimeFormat } from '../../../lib/intl-formatter-cache';

// Hoisted so every label shares one formatter cache key (#3155).
const SAME_YEAR_DAY_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
const SAME_YEAR_DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const OTHER_YEAR_DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

export type LedgerDayKeys = {
  /** Local `YYYY-MM-DD` of "now". */
  todayKey: string;
  /** Local `YYYY-MM-DD` of the calendar day before. */
  yesterdayKey: string;
};

/**
 * The local day keys the ledger's session keys are compared against. Takes
 * "now" as a number so callers hand it `nowMs()` from `lib/clock`, which keeps
 * screenshot captures on the frozen clock.
 *
 * Yesterday is one CALENDAR day back, not 24 hours: on the day the clocks
 * change, 24 hours before a just-past-midnight "now" can land two days back.
 */
export function ledgerDayKeys(nowMs: number): LedgerDayKeys {
  const today = parseTickTime(new Date(nowMs).toISOString());
  return {
    todayKey: today.format('YYYY-MM-DD'),
    yesterdayKey: today.subtract(1, 'day').format('YYYY-MM-DD'),
  };
}

// A day key names a LOCAL calendar day, so build the Date from local parts.
// `new Date('2026-06-01')` would parse as UTC midnight and print the day before
// anywhere west of Greenwich.
function localDateFromDayKey(dayKey: string): Date | null {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function sameYear(dayKey: string, todayKey: string): boolean {
  return dayKey.slice(0, 4) === todayKey.slice(0, 4);
}

/** "28 Sep" this year, "28 Sep 2025" otherwise. For use inside a sentence. */
export function formatLedgerDate(dayKey: string, todayKey: string, locale?: string): string {
  const date = localDateFromDayKey(dayKey);
  if (!date) return dayKey;
  const options = sameYear(dayKey, todayKey) ? SAME_YEAR_DATE_OPTIONS : OTHER_YEAR_DATE_OPTIONS;
  return getCachedDateTimeFormat(locale, options).format(date);
}

export type LedgerDayLabelOptions = LedgerDayKeys & {
  todayLabel: string;
  yesterdayLabel: string;
  locale?: string;
};

/** A session tile's heading: "Today", "Yesterday", "Mon 28 Sep", or "28 Sep 2025". */
export function formatLedgerDayLabel(dayKey: string, options: LedgerDayLabelOptions): string {
  if (dayKey === options.todayKey) return options.todayLabel;
  if (dayKey === options.yesterdayKey) return options.yesterdayLabel;
  const date = localDateFromDayKey(dayKey);
  if (!date) return dayKey;
  const formatOptions = sameYear(dayKey, options.todayKey) ? SAME_YEAR_DAY_OPTIONS : OTHER_YEAR_DATE_OPTIONS;
  return getCachedDateTimeFormat(options.locale, formatOptions).format(date);
}
