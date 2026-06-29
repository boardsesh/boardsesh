import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import {
  buildAngleBreakdown,
  buildWallRhythm,
  findNextProjectGrade,
  buildRunningMaxCeiling,
  buildGradeMilestones,
} from '../chart-builders';
import type { LogbookEntry } from '../types';

// TODAY is an ISO-week Monday (see dashboard-builders.test). toISOString round-trips
// the local instant through parseTickTime (utc→local) in any TZ.
const TODAY = dayjs('2026-06-15T12:00:00');
const iso = (d: dayjs.Dayjs): string => d.toISOString();

function entry(overrides: Partial<LogbookEntry> = {}): LogbookEntry {
  return { climbed_at: iso(TODAY), difficulty: 16, tries: 1, angle: 40, status: 'send', ...overrides };
}

describe('buildAngleBreakdown', () => {
  it('hides angles under 5 sends, tracks max grade, sorts steep→slab, finds home angle', () => {
    const logbook = [
      ...Array.from({ length: 5 }, () => entry({ angle: 40, difficulty: 16 })),
      entry({ angle: 40, difficulty: 22 }), // 6th @40°, max V6
      ...Array.from({ length: 5 }, () => entry({ angle: 50, difficulty: 16 })), // 5 @50°, max V3
      ...Array.from({ length: 3 }, () => entry({ angle: 30, difficulty: 16 })), // hidden (<5)
    ];
    const result = buildAngleBreakdown(logbook, 'v-grade');
    expect(result).not.toBeNull();
    expect(result!.rows.map((r) => r.angle)).toEqual([50, 40]); // steep → slab
    expect(result!.rows.find((r) => r.angle === 40)!.maxLabel).toBe('V6');
    expect(result!.homeAngle).toBe(40); // 6 sends > 5
    expect(result!.maxSendCount).toBe(6);
  });

  it('excludes attempts and returns null with no qualifying angle', () => {
    const logbook = [entry({ angle: 40, status: 'attempt' }), entry({ angle: 45, difficulty: 16 })];
    expect(buildAngleBreakdown(logbook, 'v-grade')).toBeNull();
  });
});

describe('buildWallRhythm', () => {
  it('buckets by weekday × time block and finds the hottest cell', () => {
    const tuesdayEve = TODAY.add(1, 'day').hour(19); // Tue (weekday idx 1), evening (block 2)
    const logbook = [
      entry({ climbed_at: iso(tuesdayEve) }),
      entry({ climbed_at: iso(tuesdayEve.minute(30)) }),
      entry({ climbed_at: iso(tuesdayEve.hour(20)) }),
      entry({ climbed_at: iso(TODAY.hour(8)) }), // Mon morning (0,0)
    ];
    const result = buildWallRhythm(logbook);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(4);
    expect(result!.matrix[1][2]).toBe(3); // Tue evening
    expect(result!.matrix[0][0]).toBe(1); // Mon morning
    expect(result!.hottest).toEqual({ weekday: 1, block: 2 });
    expect(result!.max).toBe(3);
  });

  it('returns null with no entries', () => {
    expect(buildWallRhythm([])).toBeNull();
  });
});

describe('findNextProjectGrade', () => {
  it('picks the thinnest sent grade above the modal grade', () => {
    const logbook = [
      ...Array.from({ length: 5 }, () => entry({ difficulty: 16 })), // V3 modal
      entry({ difficulty: 22 }), // V6 ×1 (thinnest above modal)
      ...Array.from({ length: 3 }, () => entry({ difficulty: 28 })), // V11 ×3
    ];
    expect(findNextProjectGrade(logbook, 'v-grade')).toEqual({ difficulty: 22, label: 'V6' });
  });

  it('returns null when nothing is harder than the modal grade', () => {
    expect(findNextProjectGrade([entry({ difficulty: 16 }), entry({ difficulty: 16 })], 'v-grade')).toBeNull();
  });
});

describe('buildRunningMaxCeiling', () => {
  it('produces a non-decreasing running max with best-ever + current labels', () => {
    const logbook = [
      entry({ climbed_at: iso(TODAY.subtract(2, 'week')), difficulty: 16 }), // V3
      entry({ climbed_at: iso(TODAY.subtract(1, 'week')), difficulty: 22 }), // V6
      entry({ climbed_at: iso(TODAY), difficulty: 16 }), // V3 again — max holds at V6
    ];
    const result = buildRunningMaxCeiling(logbook, 'v-grade');
    expect(result).not.toBeNull();
    expect(result!.runningMax).toEqual([16, 22, 22]);
    expect(result!.bestEverLabel).toBe('V6');
    expect(result!.currentLabel).toBe('V6');
  });

  it('returns null with no sends', () => {
    expect(buildRunningMaxCeiling([entry({ status: 'attempt' })], 'v-grade')).toBeNull();
  });
});

describe('buildGradeMilestones', () => {
  it('keeps the earliest send per grade band, sorted by grade', () => {
    const logbook = [
      entry({ climbed_at: iso(TODAY.subtract(10, 'day')), difficulty: 22 }), // V6 later
      entry({ climbed_at: iso(TODAY.subtract(40, 'day')), difficulty: 22 }), // V6 first
      entry({ climbed_at: iso(TODAY.subtract(20, 'day')), difficulty: 16 }), // V3
    ];
    const milestones = buildGradeMilestones(logbook, 'v-grade');
    expect(milestones.map((m) => m.label)).toEqual(['V3', 'V6']); // grade-ascending
    expect(milestones.find((m) => m.label === 'V6')!.date).toBe(TODAY.subtract(40, 'day').format('YYYY-MM-DD'));
  });

  it('is empty with no sends', () => {
    expect(buildGradeMilestones([entry({ status: 'attempt' })], 'v-grade')).toEqual([]);
  });
});
