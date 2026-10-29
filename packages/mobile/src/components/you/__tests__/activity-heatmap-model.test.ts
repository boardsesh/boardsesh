import { describe, expect, it } from 'vitest';
import { materialSurfaces } from '@boardsesh/velvet-tokens';
import type { RawActivityDay } from '@boardsesh/profile-stats';
import { contrastRatioHex } from '../../../lib/color-contrast-oracle';
import {
  CALENDAR_STEP_COUNT,
  FIRST_STEP_MIN_CONTRAST,
  STEP_MIN_CONTRAST,
  buildCalendarRamp,
  chunkIntoWeeks,
  localDateFromDayKey,
  monthLabelColumns,
  stepIndexForCount,
} from '../activity-heatmap-model';

// Accent + card surface for every variant/scheme the calendar draws on:
// Material reads materialSurfaces, Liquid Glass the android fallback hexes.
const PALETTES = [
  { name: 'material light', scheme: 'light', ...materialSurfaces.light },
  { name: 'material dark', scheme: 'dark', ...materialSurfaces.dark },
  { name: 'liquid glass light', scheme: 'light', accent: '#6D28D9', secondaryBackground: '#FFFFFF' },
  { name: 'liquid glass dark', scheme: 'dark', accent: '#A78BFA', secondaryBackground: '#181225' },
] as const;

function weekStarting(mondayKey: string): RawActivityDay[] {
  const monday = localDateFromDayKey(mondayKey);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { date: key, count: 0 };
  });
}

describe('buildCalendarRamp', () => {
  it.each(PALETTES)('$name: first step reaches 3:1 against the empty floor', (palette) => {
    const { emptyFill, stepFills } = buildCalendarRamp(palette.accent, palette.secondaryBackground, palette.scheme);
    expect(stepFills).toHaveLength(CALENDAR_STEP_COUNT);
    expect(contrastRatioHex(stepFills[0], emptyFill)).toBeGreaterThanOrEqual(FIRST_STEP_MIN_CONTRAST);
  });

  it.each(PALETTES)('$name: every later step is a visible notch above the one before', (palette) => {
    const { stepFills } = buildCalendarRamp(palette.accent, palette.secondaryBackground, palette.scheme);
    for (let index = 1; index < stepFills.length; index += 1) {
      const ratio = contrastRatioHex(stepFills[index], stepFills[index - 1]);
      expect(ratio).toBeGreaterThanOrEqual(STEP_MIN_CONTRAST);
      // Close to the floor, not a jump that leaves the top steps indistinct.
      expect(ratio).toBeLessThan(1.4);
    }
  });

  it.each(PALETTES)('$name: busier days move away from the card, never back toward it', (palette) => {
    const { emptyFill, stepFills } = buildCalendarRamp(palette.accent, palette.secondaryBackground, palette.scheme);
    const againstCard = [emptyFill, ...stepFills].map((fill) => contrastRatioHex(fill, palette.secondaryBackground));
    for (let index = 1; index < againstCard.length; index += 1) {
      expect(againstCard[index]).toBeGreaterThan(againstCard[index - 1]);
    }
  });
});

describe('stepIndexForCount', () => {
  it('maps empty days off the ramp and the busiest day to the top step', () => {
    expect(stepIndexForCount(0, 8)).toBe(-1);
    expect(stepIndexForCount(1, 8)).toBe(0);
    expect(stepIndexForCount(4, 8)).toBe(1);
    expect(stepIndexForCount(8, 8)).toBe(CALENDAR_STEP_COUNT - 1);
  });
});

describe('chunkIntoWeeks', () => {
  it('splits the day run into 7-day columns', () => {
    const days = [...weekStarting('2026-10-05'), ...weekStarting('2026-10-12')];
    const weeks = chunkIntoWeeks(days);
    expect(weeks).toHaveLength(2);
    expect(weeks[1][0].date).toBe('2026-10-12');
  });
});

describe('monthLabelColumns', () => {
  it('labels each column whose Monday starts a new month', () => {
    const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'].map(
      weekStarting,
    );
    // Sep 28's week holds Oct 1, but its Monday is still September.
    expect(monthLabelColumns(weeks)).toEqual([0, 4]);
  });

  it('drops the leftmost label when the next month starts too close to it', () => {
    const weeks = ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'].map(weekStarting);
    expect(monthLabelColumns(weeks)).toEqual([2]);
  });
});

describe('localDateFromDayKey', () => {
  it('builds the local calendar day, not UTC midnight', () => {
    const date = localDateFromDayKey('2026-10-14');
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 9, 14]);
  });
});
