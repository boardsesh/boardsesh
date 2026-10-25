// "Last on the wall …", the line the player shows while the #4979 hold keeps the
// board dark (docs/current-climb-outside-queue.md, section 6, decision 9). A
// dark board right after connecting reads like a Bluetooth failure, so the line
// says why: the climb has been sitting there since then.
//
// The four age bands are calendar days in the climber's local time, not 24 h
// steps, so "yesterday" is their yesterday even across a clock change.

import type { TFunction } from 'i18next';
import { getCachedDateTimeFormat } from './intl-formatter-cache';

export type LastOnWallLabel =
  /** Same calendar day (4 h or more ago): "Last on the wall at 09:30". */
  | { band: 'time'; time: string }
  /** The calendar day before: "Last on the wall yesterday". */
  | { band: 'yesterday' }
  /** 2 to 6 days back: "Last on the wall Tuesday". */
  | { band: 'weekday'; weekday: string }
  /** 7 days or more: "Last on the wall 3 Oct". */
  | { band: 'date'; date: string };

// Hoisted so every call shares one formatter cache key (#3155).
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const WEEKDAY_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'long' };
const SAME_YEAR_DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const OTHER_YEAR_DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

function localMidnight(epochMs: number): Date {
  const date = new Date(epochMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Whole calendar days from `thenMs` to `nowMs`, local time. Rounded, because a
 * day with a clock change is 23 or 25 hours long. A `thenMs` after `nowMs` (a
 * server clock running ahead) reads as the same day.
 */
export function calendarDaysBetween(thenMs: number, nowMs: number): number {
  const days = Math.round((localMidnight(nowMs).getTime() - localMidnight(thenMs).getTime()) / 86_400_000);
  return Math.max(0, days);
}

/**
 * Which band `lastOnWallAt` falls in and its formatted part, in `locale`. The
 * caller picks the matching `session.playView.wallState.lastOnWall*` string.
 */
export function resolveLastOnWallLabel(lastOnWallAt: number, nowMs: number, locale?: string): LastOnWallLabel {
  const days = calendarDaysBetween(lastOnWallAt, nowMs);
  const instant = new Date(lastOnWallAt);
  if (days === 0) return { band: 'time', time: getCachedDateTimeFormat(locale, TIME_OPTIONS).format(instant) };
  if (days === 1) return { band: 'yesterday' };
  if (days < 7) return { band: 'weekday', weekday: getCachedDateTimeFormat(locale, WEEKDAY_OPTIONS).format(instant) };
  const sameYear = instant.getFullYear() === new Date(nowMs).getFullYear();
  const dateOptions = sameYear ? SAME_YEAR_DATE_OPTIONS : OTHER_YEAR_DATE_OPTIONS;
  return { band: 'date', date: getCachedDateTimeFormat(locale, dateOptions).format(instant) };
}

/** The whole line in the app locale, from `session.playView.wallState`. */
export function formatLastOnWall(
  lastOnWallAt: number,
  nowMs: number,
  t: TFunction<'session'>,
  locale?: string,
): string {
  const label = resolveLastOnWallLabel(lastOnWallAt, nowMs, locale);
  switch (label.band) {
    case 'time':
      return t('playView.wallState.lastOnWallTime', { time: label.time });
    case 'yesterday':
      return t('playView.wallState.lastOnWallYesterday');
    case 'weekday':
      return t('playView.wallState.lastOnWallWeekday', { weekday: label.weekday });
    case 'date':
      return t('playView.wallState.lastOnWallDate', { date: label.date });
  }
}
