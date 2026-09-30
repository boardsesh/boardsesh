import { describe, expect, it } from 'vitest';
import type { LogbookEntry } from '@boardsesh/profile-stats';
import { climbingDays, dayLabel } from './climbing-days';

function entry(overrides: Partial<LogbookEntry>): LogbookEntry {
  return {
    climbed_at: '2026-09-29T18:00:00',
    difficulty: null,
    effectiveDifficulty: 18,
    tries: 1,
    angle: 40,
    status: 'send',
    boardType: 'moonboard',
    climbUuid: 'climb',
    ...overrides,
  };
}

describe('climbingDays', () => {
  it('groups ticks by day, newest first, with sends, flashes, tries and the hardest send', () => {
    const days = climbingDays([
      entry({ climbed_at: '2026-09-28T19:00:00', status: 'flash', effectiveDifficulty: 17 }),
      entry({ climbed_at: '2026-09-29T18:00:00', status: 'send', tries: 3, effectiveDifficulty: 20 }),
      entry({ climbed_at: '2026-09-29T18:30:00', status: 'attempt', tries: 5, effectiveDifficulty: 24 }),
      entry({ climbed_at: '2026-09-29T19:00:00', status: 'flash', effectiveDifficulty: 19 }),
    ]);
    expect(days).toEqual([
      { date: '2026-09-29', sends: 2, flashes: 1, tries: 9, hardestSendDifficulty: 20 },
      { date: '2026-09-28', sends: 1, flashes: 1, tries: 1, hardestSendDifficulty: 17 },
    ]);
  });

  it('prefers the climber’s own grade only where there is no consensus grade', () => {
    const [day] = climbingDays([entry({ effectiveDifficulty: null, difficulty: 22 })]);
    expect(day.hardestSendDifficulty).toBe(22);
  });
});

describe('dayLabel', () => {
  const today = new Date(2026, 8, 29, 20, 0);
  it('names today and yesterday', () => {
    expect(dayLabel('2026-09-29', today)).toBe('Today');
    expect(dayLabel('2026-09-28', today)).toBe('Yesterday');
    expect(dayLabel('2026-09-22', today)).not.toMatch(/Today|Yesterday/);
  });
});
