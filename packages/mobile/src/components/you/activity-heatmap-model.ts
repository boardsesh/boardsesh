import type { RawActivityDay } from '@boardsesh/profile-stats';
import { blendOpaque } from '@boardsesh/velvet-tokens';
import { contrastRatioHex } from '../../lib/color-contrast-oracle';

export const CALENDAR_ROWS = 7;
export const CALENDAR_STEP_COUNT = 4;
// WCAG 1.4.11 non-text contrast: "climbed" must read against "didn't" at 3:1,
// then each busier step is a visible notch (the hold heat ramp's 1.3:1).
export const FIRST_STEP_MIN_CONTRAST = 3;
export const STEP_MIN_CONTRAST = 1.3;
// Opaque-composite alphas for the empty floor (kept faint, scheme-tuned).
const EMPTY_FLOOR_ALPHA_DARK = 0.14;
const EMPTY_FLOOR_ALPHA_LIGHT = 0.08;
// The ramp walks surface → accent (t 0..1), then past the accent toward white
// (dark) or black (light) for t 1..MAX_RAMP_T. Capped short of the extreme so
// the busiest day keeps its violet tint.
const MAX_RAMP_T = 1.8;
const RAMP_T_STEP = 0.01;
// Month labels closer than this many columns would collide ("Sep" is ~2 cells).
export const MIN_MONTH_LABEL_GAP = 3;
// Mon, Wed, Fri: the grid is ISO-week aligned, so row 0 is always Monday.
export const LABELLED_WEEKDAY_ROWS = [0, 2, 4] as const;

export type CalendarRamp = {
  emptyFill: string;
  stepFills: string[];
};

function rampColor(accent: string, surface: string, extreme: string, t: number): string {
  return t <= 1 ? blendOpaque(accent, surface, t) : blendOpaque(extreme, accent, t - 1);
}

/**
 * Empty floor plus four intensity steps, searched along the accent's own
 * lightness path rather than fixed alphas: the first step is the first colour
 * that reaches 3:1 against the empty floor, each later step the first that
 * reaches 1.3:1 against the one before. Fixed alphas left "climbed one route"
 * at ~1.65:1 against "didn't climb" in dark mode (#6936).
 */
export function buildCalendarRamp(accent: string, surface: string, colorScheme: 'light' | 'dark'): CalendarRamp {
  const floorAlpha = colorScheme === 'dark' ? EMPTY_FLOOR_ALPHA_DARK : EMPTY_FLOOR_ALPHA_LIGHT;
  const extreme = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const emptyFill = blendOpaque(accent, surface, floorAlpha);
  const stepFills: string[] = [];
  let previous = emptyFill;
  let rampT = floorAlpha;
  for (let stepIndex = 0; stepIndex < CALENDAR_STEP_COUNT; stepIndex += 1) {
    const target = stepIndex === 0 ? FIRST_STEP_MIN_CONTRAST : STEP_MIN_CONTRAST;
    let candidate = rampColor(accent, surface, extreme, rampT);
    while (rampT < MAX_RAMP_T && contrastRatioHex(candidate, previous) < target) {
      rampT = Math.min(MAX_RAMP_T, rampT + RAMP_T_STEP);
      candidate = rampColor(accent, surface, extreme, rampT);
    }
    stepFills.push(candidate);
    previous = candidate;
  }
  return { emptyFill, stepFills };
}

/** Index into the step ramp for a day's count; -1 for an empty day. */
export function stepIndexForCount(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return -1;
  const ratio = count / maxCount;
  return Math.min(CALENDAR_STEP_COUNT - 1, Math.max(0, Math.ceil(ratio * CALENDAR_STEP_COUNT) - 1));
}

export function chunkIntoWeeks(days: readonly RawActivityDay[]): RawActivityDay[][] {
  const weeks: RawActivityDay[][] = [];
  for (let index = 0; index < days.length; index += CALENDAR_ROWS) {
    weeks.push(days.slice(index, index + CALENDAR_ROWS));
  }
  return weeks;
}

/**
 * Which visible columns carry a month label: a column whose Monday falls in a
 * different month from the previous column's. The leftmost column always
 * starts a month run, but its label is dropped when the next month begins
 * within MIN_MONTH_LABEL_GAP columns, so the two never overlap.
 */
export function monthLabelColumns(weeks: readonly RawActivityDay[][]): number[] {
  const columns: number[] = [];
  for (let columnIndex = 0; columnIndex < weeks.length; columnIndex += 1) {
    const monthKey = weeks[columnIndex][0]?.date.slice(0, 7);
    const previousMonthKey = columnIndex > 0 ? weeks[columnIndex - 1][0]?.date.slice(0, 7) : undefined;
    if (monthKey && monthKey !== previousMonthKey) columns.push(columnIndex);
  }
  if (columns.length > 1 && columns[1] - columns[0] < MIN_MONTH_LABEL_GAP) columns.shift();
  return columns;
}

/**
 * A `YYYY-MM-DD` key names a LOCAL calendar day, so build the Date from local
 * parts; `new Date('2026-10-14')` parses as UTC midnight and prints the day
 * before anywhere west of Greenwich.
 */
export function localDateFromDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}
