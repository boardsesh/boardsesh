import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import {
  buildWeeklyStreak,
  buildProjectingStats,
  buildActiveDaysMoM,
  buildLastSendGap,
  buildBenchmarkSummary,
} from '../chart-builders';
import type { LogbookEntry } from '../types';

// Fixed anchor (local time, midday to dodge DST/day-boundary flips). The
// builders convert climbed_at via parseTickTime (utc→local); generating
// climbed_at with toISOString round-trips to the same local instant in any TZ.
const TODAY = dayjs('2026-06-15T12:00:00');
const iso = (d: dayjs.Dayjs): string => d.toISOString();

function entry(climbedAt: string, overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return { climbed_at: climbedAt, difficulty: 22, tries: 1, angle: 40, status: 'send', ...overrides };
}

describe('buildWeeklyStreak', () => {
  it('is all zero for an empty logbook', () => {
    expect(buildWeeklyStreak([], TODAY)).toEqual({ currentWeeks: 0, longestWeeks: 0, isCurrentWeekActive: false });
  });

  it('counts consecutive active weeks ending this week', () => {
    const logbook = [entry(iso(TODAY)), entry(iso(TODAY.subtract(1, 'week'))), entry(iso(TODAY.subtract(2, 'week')))];
    const streak = buildWeeklyStreak(logbook, TODAY);
    expect(streak.currentWeeks).toBe(3);
    expect(streak.longestWeeks).toBe(3);
    expect(streak.isCurrentWeekActive).toBe(true);
  });

  it('keeps the streak alive through last week (grace), flag off', () => {
    const streak = buildWeeklyStreak([entry(iso(TODAY.subtract(1, 'week')))], TODAY);
    expect(streak.currentWeeks).toBe(1);
    expect(streak.isCurrentWeekActive).toBe(false);
  });

  it('lapses current streak to 0 once the last active week is stale, keeps longest', () => {
    const logbook = [entry(iso(TODAY.subtract(3, 'week'))), entry(iso(TODAY.subtract(4, 'week')))];
    const streak = buildWeeklyStreak(logbook, TODAY);
    expect(streak.currentWeeks).toBe(0);
    expect(streak.longestWeeks).toBe(2);
  });

  it('dedups multiple ticks in the same week', () => {
    // TODAY is an ISO-week Monday; +3 days stays inside the same ISO week.
    const logbook = [entry(iso(TODAY)), entry(iso(TODAY.add(3, 'day')))];
    const streak = buildWeeklyStreak(logbook, TODAY);
    expect(streak.currentWeeks).toBe(1);
    expect(streak.longestWeeks).toBe(1);
  });
});

describe('buildProjectingStats', () => {
  it('buckets sent climbs by tries and excludes attempts from the histogram', () => {
    const logbook = [
      entry(iso(TODAY), { status: 'flash', tries: 1 }),
      entry(iso(TODAY), { status: 'send', tries: 3 }),
      entry(iso(TODAY), { status: 'send', tries: 8 }),
      entry(iso(TODAY), { status: 'send', tries: 30, climbUuid: 'proj', difficulty: 28 }),
      entry(iso(TODAY), { status: 'attempt', tries: 50 }), // excluded
    ];
    const stats = buildProjectingStats(logbook, 'v-grade');
    const byKey = Object.fromEntries(stats.buckets.map((b) => [b.key, b.value]));
    expect(byKey).toEqual({ '1': 1, '2-5': 1, '6-20': 1, '20+': 1 });
    // biggest fight is the 30-try SEND, never the 50-try attempt
    expect(stats.biggestProject).toMatchObject({ tries: 30, climbUuid: 'proj', label: 'V11' });
    expect(stats.unlocked).toBe(true);
  });

  it('stays locked when the hardest-won send took < 4 tries', () => {
    const logbook = [entry(iso(TODAY), { status: 'flash', tries: 1 }), entry(iso(TODAY), { status: 'send', tries: 3 })];
    const stats = buildProjectingStats(logbook, 'v-grade');
    expect(stats.unlocked).toBe(false);
    expect(stats.biggestProject?.tries).toBe(3);
  });
});

describe('buildActiveDaysMoM', () => {
  it('counts distinct active days this vs last month with a 6-month sparkline', () => {
    const logbook = [
      entry(iso(TODAY)), // Jun 15
      entry(iso(TODAY)), // dup same day
      entry(iso(TODAY.subtract(13, 'day'))), // Jun 2
      entry(iso(TODAY.subtract(1, 'month'))), // May 15
      entry(iso(TODAY.subtract(1, 'month').subtract(2, 'day'))), // May 13
    ];
    const mom = buildActiveDaysMoM(logbook, TODAY);
    expect(mom.thisMonth).toBe(2);
    expect(mom.lastMonth).toBe(2);
    expect(mom.delta).toBe(0);
    expect(mom.sparkline).toHaveLength(6);
    expect(mom.sparkline[5]).toBe(2); // current month
    expect(mom.sparkline[4]).toBe(2); // last month
  });
});

describe('buildLastSendGap', () => {
  it('returns nulls when there are no sends', () => {
    const gap = buildLastSendGap([entry(iso(TODAY), { status: 'attempt' })], TODAY);
    expect(gap).toEqual({ daysSinceLastSend: null, lastSendAt: null, isComeback: false, comebackGapDays: null });
  });

  it('flags a comeback when the latest send closed a >30-day gap', () => {
    const logbook = [entry(iso(TODAY.subtract(5, 'day'))), entry(iso(TODAY.subtract(40, 'day')))];
    const gap = buildLastSendGap(logbook, TODAY);
    expect(gap.daysSinceLastSend).toBe(5);
    expect(gap.comebackGapDays).toBe(35);
    expect(gap.isComeback).toBe(true);
  });

  it('does not flag a comeback for a short gap', () => {
    const logbook = [entry(iso(TODAY.subtract(5, 'day'))), entry(iso(TODAY.subtract(10, 'day')))];
    expect(buildLastSendGap(logbook, TODAY).isComeback).toBe(false);
  });
});

describe('buildBenchmarkSummary', () => {
  it('counts distinct benchmark sends (climb-level flag), dedups, tracks hardest', () => {
    const logbook = [
      entry(iso(TODAY), { isBenchmark: true, status: 'send', climbUuid: 'b1', difficulty: 22 }), // V6
      entry(iso(TODAY), { isBenchmark: true, status: 'flash', climbUuid: 'b2', difficulty: 28 }), // V11
      entry(iso(TODAY), { isBenchmark: true, status: 'send', climbUuid: 'b1', difficulty: 22 }), // dup → not recounted
      entry(iso(TODAY), { isBenchmark: false, status: 'send', climbUuid: 'n1', difficulty: 28 }), // not a benchmark
      entry(iso(TODAY), { isBenchmark: true, status: 'attempt', climbUuid: 'b3', difficulty: 30 }), // not sent
    ];
    const summary = buildBenchmarkSummary(logbook, 'v-grade');
    expect(summary.count).toBe(2);
    expect(summary.hardestLabel).toBe('V11');
  });

  it('is empty when nothing is benchmarked', () => {
    expect(buildBenchmarkSummary([entry(iso(TODAY))], 'v-grade')).toEqual({
      count: 0,
      hardestDifficulty: null,
      hardestLabel: null,
    });
  });
});
