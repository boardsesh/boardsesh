import type { LogbookDateWindow, LogbookFilterState } from './types';

/** The date windows, in display order (Any time · This week · … · Custom). */
export const LOGBOOK_DATE_WINDOWS: readonly LogbookDateWindow[] = [
  'any',
  'last7',
  'month',
  'last3months',
  'year',
  'custom',
];

/** The rolling windows: they end today and move with the calendar. */
export function isRollingLogbookDateWindow(window: LogbookDateWindow): boolean {
  return window !== 'any' && window !== 'custom';
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of a Date on the DEVICE's local calendar (never UTC). */
export function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Local midnight of a `YYYY-MM-DD` calendar day, or null when the string isn't
 * a real date (shape, month 13, Feb 30). `dayOffset` moves whole calendar days,
 * so `parseLocalIsoDate(day, 1)` is the start of the next day even across DST.
 */
export function parseLocalIsoDate(value: string, dayOffset = 0): Date | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  // The Date constructor rolls Feb 30 over to Mar 2; a real date round-trips.
  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) return null;
  return dayOffset === 0 ? date : new Date(year, monthIndex, day + dayOffset);
}

/** Days in a local calendar month; `monthIndex` may be out of 0-11 (it wraps years). */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * The first day a window covers, on the local calendar of `now`. Built from
 * local Y/M/D parts so month and year rollovers (and DST) fall out of the Date
 * constructor rather than hand arithmetic.
 */
function windowStart(window: LogbookDateWindow, now: Date): Date | null {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  switch (window) {
    case 'last7':
      // Today and the six days before it.
      return new Date(year, month, day - 6);
    case 'month':
      return new Date(year, month, 1);
    case 'last3months': {
      // Same day three months ago, clamped to that month's last day so May 31
      // lands on Feb 28/29 instead of overflowing into March.
      const startMonth = month - 3;
      return new Date(year, startMonth, Math.min(day, daysInMonth(year, startMonth)));
    }
    case 'year':
      return new Date(year, 0, 1);
    case 'any':
    case 'custom':
    default:
      return null;
  }
}

/**
 * The calendar range a filter covers, as local ISO dates ('' = open). Rolling
 * windows run from their first day to today; `custom` passes the stored
 * from/to through; `any` is open on both sides.
 */
export function resolveLogbookDateRange(
  filters: Pick<LogbookFilterState, 'dateWindow' | 'fromDate' | 'toDate'>,
  now: Date,
): { fromDate: string; toDate: string } {
  if (filters.dateWindow === 'custom') {
    return { fromDate: filters.fromDate, toDate: filters.toDate };
  }
  const start = windowStart(filters.dateWindow, now);
  if (!start) return { fromDate: '', toDate: '' };
  return { fromDate: localIsoDate(start), toDate: localIsoDate(now) };
}

/**
 * True when the date filter narrows the list. A Custom window with neither
 * bound picked yet narrows nothing, so it isn't counted as active.
 */
export function isLogbookDateFilterActive(
  filters: Pick<LogbookFilterState, 'dateWindow' | 'fromDate' | 'toDate'>,
): boolean {
  if (filters.dateWindow === 'custom') return Boolean(filters.fromDate || filters.toDate);
  return filters.dateWindow !== 'any';
}
